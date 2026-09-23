// Bulk tier: every germline ClinVar Pathogenic/Likely pathogenic variant with an rsID,
// ≥1 review star and GRCh37 VCF alleles, plus the PubMed papers ClinVar cites for it.
// Input: pipeline/cache/bulk/variant_summary.txt.gz, var_citations.txt (NCBI FTP).
// Output: pipeline/out/clinvar-bulk.json (compact; see src/core/bulk.ts for the reader).
import { createReadStream, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT, writeJson } from "../lib/http";

const DIR = join(ROOT, "pipeline/cache/bulk");
const PATHOGENIC = /(^|[\s/;,])(likely )?pathogenic(?!ity)/i;

export function starsFor(status: string): number {
  const s = status.toLowerCase();
  if (s.startsWith("no ")) return 0; // "no assertion criteria provided", "no classification provided", ...
  if (s.includes("practice guideline")) return 4;
  if (s.includes("expert panel")) return 3;
  if (s.includes("multiple submitters, no conflicts")) return 2;
  if (s.includes("criteria provided")) return 1;
  return 0;
}

/** Keep aggregate P/LP (not conflicting), ≥1 star, germline, with rsID and simple VCF alleles. */
export function keepRow(r: Record<string, string>): boolean {
  const sig = r.ClinicalSignificance ?? r.GermlineClassification ?? "";
  if (!PATHOGENIC.test(sig) || /conflicting/i.test(sig)) return false;
  if (r.Assembly !== "GRCh37" || r["RS# (dbSNP)"] === "-1" || !r["RS# (dbSNP)"]) return false;
  if (!/germline|inherited|de novo|maternal|paternal|biparental|unknown/i.test(r.OriginSimple ?? r.Origin ?? "")) return false;
  if (starsFor(r.ReviewStatus ?? "") < 1) return false;
  const ref = r.ReferenceAlleleVCF, alt = r.AlternateAlleleVCF;
  return !!ref && !!alt && ref !== "na" && alt !== "na" && /^[ACGT]+$/.test(ref) && /^[ACGT]+$/.test(alt) && Math.max(ref.length, alt.length) <= 50;
}

async function* rows(path: string, gz: boolean) {
  const input = gz ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  let header: string[] | null = null;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const cols = line.split("\t");
    if (!header) { header = cols.map((c) => c.replace(/^#/, "")); continue; }
    yield Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
  }
}

async function main() {
  const vs = join(DIR, "variant_summary.txt.gz");
  const genes: string[] = [], geneIdx = new Map<string, number>();
  const conds: string[] = [], condIdx = new Map<string, number>();
  const idx = (m: Map<string, number>, arr: string[], k: string) => { if (!m.has(k)) { m.set(k, arr.length); arr.push(k); } return m.get(k)!; };
  // [rsNum, chrom, pos37, ref, alt, sig, stars, geneIdx, condIdx[], variationId, lastEvaluated, name]
  const out: unknown[][] = [];
  const keptVariation = new Set<string>();
  let seen = 0;
  for await (const r of rows(vs, true)) {
    seen++;
    if (!keepRow(r)) continue;
    const sig = r.ClinicalSignificance ?? r.GermlineClassification;
    const conditions = (r.PhenotypeList ?? "").split(/[|;]/).map((c) => c.trim()).filter((c) => c && !/^(not provided|not specified|see cases)$/i.test(c));
    out.push([
      Number(r["RS# (dbSNP)"]), r.Chromosome, Number(r.PositionVCF), r.ReferenceAlleleVCF, r.AlternateAlleleVCF, sig,
      starsFor(r.ReviewStatus), idx(geneIdx, genes, r.GeneSymbol || "-"), [...new Set(conditions)].slice(0, 6).map((c) => idx(condIdx, conds, c)),
      Number(r.VariationID), r.LastEvaluated && r.LastEvaluated !== "-" ? r.LastEvaluated : "", r.Name,
    ]);
    keptVariation.add(r.VariationID);
  }
  console.log(`variant_summary: ${seen.toLocaleString()} rows, kept ${out.length.toLocaleString()}`);

  // Papers ClinVar cites for each kept variant.
  const cites: Record<string, number[]> = {};
  for await (const r of rows(join(DIR, "var_citations.txt"), false)) {
    if (r.citation_source !== "PubMed" || !keptVariation.has(r.VariationID)) continue;
    const pm = Number(r.citation_id);
    if (!pm) continue;
    (cites[r.VariationID] ??= []).includes(pm) || cites[r.VariationID].push(pm);
  }
  const pmids = new Set(Object.values(cites).flat());
  console.log(`citations: ${Object.keys(cites).length.toLocaleString()} variants, ${pmids.size.toLocaleString()} unique PMIDs`);
  const version = statSync(vs).mtime.toISOString().slice(0, 10);
  writeJson("pipeline/out/clinvar-bulk.json", { version, retrievedAt: new Date().toISOString().slice(0, 10), genes, conditions: conds, rows: out, cites });
}

if (process.argv[1]?.endsWith("clinvar.ts")) main().catch((e) => { console.error(e); process.exit(1); });

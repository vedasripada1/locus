// Bulk tier: every genome-wide significant (p < 5e-8) single-SNP GWAS Catalog association
// with a concrete effect allele, an effect size and one mapped trait, grouped per (rsID, trait).
// Grouping happens here so the browser gets one row per (rsID, trait) with the replication
// statistics and every paper that reported the association.
// Inputs (pipeline/cache/bulk): gwas/*.tsv (catalog "associations v1.0.2" download, unzipped),
// gwas_trait_mappings.tsv; Ensembl REST for forward-strand alleles.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT, writeJson } from "../lib/http";
import { ensemblSites, type EnsemblSite } from "./ensembl";

const DIR = join(ROOT, "pipeline/cache/bulk");
const COMP: Record<string, string> = { A: "T", T: "A", C: "G", G: "C" };
const MAX_PMIDS = 25;

export type Domain = "disease" | "metabolism" | "performance" | "other";
const DISEASE = new Set(["Cancer", "Cardiovascular disease", "Digestive system disorder", "Immune system disorder", "Metabolic disorder", "Neurological disorder", "Other disease"]);
const MEASURE = new Set(["Lipid or lipoprotein measurement", "Body measurement", "Cardiovascular measurement", "Hematological measurement", "Inflammatory measurement", "Liver enzyme measurement", "Other measurement"]);
const PERFORMANCE = /grip strength|physical activity|cardiorespiratory fitness|vo2|athlet|sprint|endurance|exercise|muscle (strength|mass)|walking pace|appendicular lean mass|lean body mass|heart rate recovery/i;

export function domainFor(label: string, categories: string[]): Domain {
  if (PERFORMANCE.test(label)) return "performance";
  if (categories.some((c) => DISEASE.has(c))) return "disease";
  if (categories.some((c) => MEASURE.has(c))) return "metabolism";
  return "other";
}

/** OR vs β: the catalog puts "increase"/"decrease" (with units) in the CI text for betas. */
export function effectKind(ciText: string): { kind: "OR" | "beta"; dir: 1 | -1 | 0 } {
  if (/increase/i.test(ciText)) return { kind: "beta", dir: 1 };
  if (/decrease/i.test(ciText)) return { kind: "beta", dir: -1 };
  if (/unit|sd|z-?score|mmol|mg\/dl|%|cm|kg/i.test(ciText)) return { kind: "beta", dir: 0 };
  return { kind: "OR", dir: 0 };
}

interface Assoc { freq: number | null; gene: string; rsid: string; allele: string; value: number; kind: "OR" | "beta"; dir: 1 | -1 | 0; ci: string; p: string; mlog: number; pmid: number; study: string; sample: string; uri: string; trait: string }

/** Main alternate allele: Ensembl minor allele if it is an alt, else the alt most often reported as effect allele. */
export function mainAltFor(s: EnsemblSite, reported: string[]): string {
  if (s.minor && s.minor !== s.ref && s.alts.includes(s.minor)) return s.minor;
  if (s.alts.length === 1) return s.alts[0];
  const votes = new Map<string, number>();
  for (const a of reported) {
    const f = s.alts.includes(a) ? a : s.alts.includes(COMP[a]) ? COMP[a] : null;
    if (f) votes.set(f, (votes.get(f) ?? 0) + 1);
  }
  return [...votes].sort((x, y) => y[1] - x[1])[0]?.[0] ?? s.alts[0];
}

/** Orient a reported allele against the (ref, mainAlt) pair; null when ambiguous or unresolvable. */
export function orient(a: string, ref: string, mainAlt: string): { allele: string | null; how: "forward" | "complemented" | "ambiguous" | "unresolvable" } {
  if (COMP[ref] === mainAlt) return [ref, mainAlt].includes(a) ? { allele: a, how: "ambiguous" } : { allele: null, how: "unresolvable" };
  if (a === ref || a === mainAlt) return { allele: a, how: "forward" };
  if (COMP[a] === ref || COMP[a] === mainAlt) return { allele: COMP[a], how: "complemented" };
  return { allele: null, how: "unresolvable" };
}

async function* tsv(path: string) {
  let header: string[] | null = null;
  for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
    const cols = line.split("\t");
    if (!header) { header = cols; continue; }
    yield Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
  }
}

async function main() {
  // Trait categories.
  const cats = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  for await (const r of tsv(join(DIR, "gwas_trait_mappings.tsv"))) {
    const s = cats.get(r["EFO URI"]) ?? new Set<string>();
    s.add(r["Parent term"]); cats.set(r["EFO URI"], s);
    labels.set(r["EFO URI"], r["EFO term"]);
  }

  // Associations.
  const byGroup = new Map<string, Assoc[]>();
  const studies: Record<string, [string, string, string, string]> = {}; // pmid → [first author, year, journal, title]
  const aliases: Record<string, string> = {}; // reported rsID → current rsID
  let n = 0;
  for (const f of readdirSync(join(DIR, "gwas")).filter((x) => x.endsWith(".tsv"))) {
    for await (const r of tsv(join(DIR, "gwas", f))) {
      n++;
      const mlog = Number(r.PVALUE_MLOG);
      if (!(mlog >= 7.30103)) continue;
      const snp = r.SNPS.trim();
      const m = r["STRONGEST SNP-RISK ALLELE"].trim().match(/^(rs\d+)-([ACGT])$/);
      if (!/^rs\d+$/.test(snp) || !m) continue;
      const value = Number(r["OR or BETA"]);
      if (!r["OR or BETA"] || !Number.isFinite(value) || value === 0) continue;
      const uris = r.MAPPED_TRAIT_URI.split(",").map((u) => u.trim()).filter(Boolean);
      if (uris.length !== 1) continue;
      const current = r.SNP_ID_CURRENT && /^\d+$/.test(r.SNP_ID_CURRENT) ? `rs${r.SNP_ID_CURRENT}` : snp;
      if (current !== snp) aliases[snp] = current;
      const { kind, dir } = effectKind(r["95% CI (TEXT)"]);
      const a: Assoc = {
        freq: (() => { const f = Number(r["RISK ALLELE FREQUENCY"]); return Number.isFinite(f) && f > 0 && f < 1 ? f : null; })(),
        gene: (r.MAPPED_GENE.split(/[,;]| - /)[0] ?? "").trim().slice(0, 40), rsid: current, allele: m[2], value, kind, dir, ci: r["95% CI (TEXT)"].trim(), p: r["P-VALUE"].trim(), mlog, pmid: Number(r.PUBMEDID),
        study: r["STUDY ACCESSION"], sample: r["INITIAL SAMPLE SIZE"].trim().slice(0, 240), uri: uris[0], trait: r.MAPPED_TRAIT.trim(),
      };
      const k = `${a.rsid}|${a.uri}`;
      (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(a);
      studies[a.pmid] ??= [r["FIRST AUTHOR"], r.DATE.slice(0, 4), r.JOURNAL, r.STUDY.slice(0, 300)];
    }
  }
  const rsids = [...new Set([...byGroup.keys()].map((k) => k.split("|")[0]))];
  console.log(`catalog rows ${n.toLocaleString()}; groups ${byGroup.size.toLocaleString()}; rsIDs ${rsids.length.toLocaleString()}`);

  const ens = await ensemblSites(rsids);
  console.log(`ensembl alleles for ${ens.size.toLocaleString()} rsIDs`);

  // Build compact output.
  const traitIdx = new Map<string, number>();
  const traits: [label: string, uri: string, categories: string, domain: Domain][] = [];
  const sites: Record<string, [chrom: string, pos37: number | null, ref: string, mainAlt: string, alts: string, gene: string]> = {};
  const samples: string[] = []; const sampleIdx = new Map<string, number>();
  // group row: [rsid, traitIdx, leadAllele, leadForward, value, kind(0=OR,1=beta), dir, ci, p, leadPmid, sampleIdx, concordantPubs, discordantAssocs, nAssocs, pmids, how, leadAlleleFrequency]
  const groups: unknown[][] = [];
  let skipped = 0;
  const sign = (a: Assoc): 1 | -1 | 0 => (a.kind === "OR" ? (a.value > 1 ? 1 : a.value < 1 ? -1 : 0) : a.dir);
  for (const [k, list] of byGroup) {
    const rsid = k.split("|")[0];
    const s = ens.get(rsid);
    if (!s || s.ref.length !== 1 || s.alts.some((x) => x.length !== 1)) { skipped++; continue; }
    const mainAlt = mainAltFor(s, list.map((a) => a.allele));
    sites[rsid] ??= [s.chrom, s.pos37, s.ref, mainAlt, s.alts.join(","), list.find((a) => a.gene)?.gene ?? ""];
    const directed = list.map((a) => {
      const o = orient(a.allele, s.ref, mainAlt);
      const sg = sign(a);
      return { a, o, d: !o.allele || sg === 0 ? 0 : o.allele === mainAlt ? sg : -sg };
    });
    const up = directed.filter((x) => x.d === 1).length, down = directed.filter((x) => x.d === -1).length;
    const maj = up + down === 0 ? 0 : up >= down ? 1 : -1;
    const conc = directed.filter((x) => maj !== 0 && x.d === maj);
    const pool = conc.length ? conc : directed;
    const lead = [...pool].sort((x, y) => y.a.mlog - x.a.mlog)[0];
    const uri = lead.a.uri;
    if (!traitIdx.has(uri)) {
      const label = labels.get(uri) ?? lead.a.trait;
      const c = [...(cats.get(uri) ?? [])];
      traitIdx.set(uri, traits.length);
      traits.push([label, uri, c.join("; "), domainFor(label, c)]);
    }
    if (!sampleIdx.has(lead.a.sample)) { sampleIdx.set(lead.a.sample, samples.length); samples.push(lead.a.sample); }
    const pmids = [...new Set(list.sort((x, y) => y.mlog - x.mlog).map((a) => a.pmid))].slice(0, MAX_PMIDS);
    groups.push([
      rsid, traitIdx.get(uri), lead.a.allele, lead.o.allele ?? "", lead.a.value, lead.a.kind === "OR" ? 0 : 1, sign(lead.a), lead.a.ci, lead.a.p,
      lead.a.pmid, sampleIdx.get(lead.a.sample), new Set(conc.map((x) => x.a.pmid)).size, maj === 0 ? 0 : directed.filter((x) => x.d === -maj).length,
      list.length, pmids, lead.o.how, lead.a.freq,
    ]);
  }
  const usedPmids = new Set(groups.flatMap((g) => g[14] as number[]));
  const studiesOut = Object.fromEntries(Object.entries(studies).filter(([p]) => usedPmids.has(Number(p))));
  console.log(`groups kept ${groups.length.toLocaleString()} (skipped ${skipped.toLocaleString()} without single-base Ensembl alleles); studies ${Object.keys(studiesOut).length.toLocaleString()}`);
  // Release date = newest file inside the catalog zip (their mtimes are the release timestamps).
  const version = readdirSync(join(DIR, "gwas")).map((f) => statSync(join(DIR, "gwas", f)).mtime).sort((a, b) => +b - +a)[0].toISOString().slice(0, 10);
  writeJson("pipeline/out/gwas-bulk.json", { version, retrievedAt: new Date().toISOString().slice(0, 10), traits, sites, samples, groups, studies: studiesOut, aliases });
}

if (process.argv[1]?.endsWith("gwas.ts")) main().catch((e) => { console.error(e); process.exit(1); });

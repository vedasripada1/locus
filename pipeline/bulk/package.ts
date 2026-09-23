// Packages the bulk tiers for the browser as gzipped JSON under public/data/:
//   clinvar.json.gz  – P/LP variants (+ ClinVar-cited PMIDs per variant)
//   gwas.json.gz     – grouped GWAS associations (+ catalog study metadata per PMID)
//   papers.json.gz   – title/author/journal/year for every PMID the app can show,
//                      plus per-site ClinVar citations and LitVar2 mentions for curated sites
// Loaded same-origin at runtime (CSP allows connect-src 'self' only).
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { get, ROOT } from "../lib/http";
import { paperMeta } from "./papers";
import type { EvidenceBundle } from "../../src/core/types";

const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const OUT = join(ROOT, "public/data");

function write(name: string, obj: unknown) {
  mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(obj);
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(join(OUT, name), gz);
  console.log(`  ${name}: ${(json.length / 1e6).toFixed(1)} MB → ${(gz.length / 1e6).toFixed(1)} MB gz`);
}

async function litvar(rsid: string): Promise<number[]> {
  try {
    const c = await get<any>(`https://www.ncbi.nlm.nih.gov/research/litvar2-api/variant/get/litvar%40${rsid}%23%23/publications`);
    return (c.body.pmids ?? []).map(Number).filter(Boolean);
  } catch { return []; }
}

async function main() {
  const bundle: EvidenceBundle = read("src/evidence/bundle.json");
  const curated = new Set(bundle.sites.flatMap((s) => [s.rsid, ...s.aliases]));

  // ClinVar bulk (curated sites excluded: they have richer per-condition records).
  const cv = read("pipeline/out/clinvar-bulk.json");
  const sigs: string[] = []; const sigIdx = new Map<string, number>();
  const rows = (cv.rows as any[][]).filter((r) => !curated.has(`rs${r[0]}`)).map((r) => {
    if (!sigIdx.has(r[5])) { sigIdx.set(r[5], sigs.length); sigs.push(r[5]); }
    return [r[0], r[1], r[2], r[3], r[4], sigIdx.get(r[5]), r[6], r[7], r[8], r[9], r[10], r[11]];
  });
  const kept = new Set(rows.map((r) => String(r[9])));
  const cites = Object.fromEntries(Object.entries(cv.cites as Record<string, number[]>).filter(([v]) => kept.has(v)));

  // Curated sites: ClinVar citations for their records, and LitVar2 text-mined mentions.
  const curatedVar = new Map(bundle.clinvar.map((r) => [r.url.match(/variation\/(\d+)/)?.[1] ?? "", r.rsid]));
  const curatedCites: Record<string, number[]> = {};
  const rl = createInterface({ input: createReadStream(join(ROOT, "pipeline/cache/bulk/var_citations.txt")), crlfDelay: Infinity });
  for await (const line of rl) {
    const c = line.split("\t"); // AlleleID VariationID rs nsv citation_source citation_id
    const rs = curatedVar.get(c[1]);
    if (rs && c[4] === "PubMed" && Number(c[5])) (curatedCites[`${rs}|${c[1]}`] ??= []).push(Number(c[5]));
  }
  const lit: Record<string, number[]> = {};
  for (const s of bundle.sites) lit[s.rsid] = await litvar(s.rsid);

  // GWAS bulk passes through (already compact).
  const gw = existsSync(join(ROOT, "pipeline/out/gwas-bulk.json")) ? read("pipeline/out/gwas-bulk.json") : null;
  if (!gw) console.warn("pipeline/out/gwas-bulk.json not built yet: skipping gwas.json.gz");

  // Paper metadata for everything we may display outside the GWAS catalog's own study table.
  const pmids = [...Object.values(cites).flat(), ...Object.values(curatedCites).flat(), ...Object.values(lit).flat(), ...bundle.gwas.map((a) => Number(a.pmid))];
  console.log(`paper metadata for ${new Set(pmids).size.toLocaleString()} PMIDs…`);
  const papers = await paperMeta(pmids);

  console.log("writing public/data:");
  write("clinvar.json.gz", { version: cv.version, retrievedAt: cv.retrievedAt, genes: cv.genes, conditions: cv.conditions, sigs, rows, cites });
  if (gw) write("gwas.json.gz", gw);
  write("papers.json.gz", { retrievedAt: new Date().toISOString().slice(0, 10), papers, curatedCites, litvar: lit });
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
    builtAt: new Date().toISOString(), clinvar: { version: cv.version, variants: rows.length }, gwas: gw ? { version: gw.version, groups: gw.groups.length, sites: Object.keys(gw.sites).length } : null,
    papers: Object.keys(papers).length,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });

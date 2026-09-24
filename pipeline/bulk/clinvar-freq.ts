// Population allele frequencies for every ClinVar P/LP rsID (bulk + curated), from Ensembl GRCh37
// (1000 Genomes phase 3 global minor-allele frequency). Used to stop common alleles raising alarms:
// a variant carried by many people cannot on its own cause a rare disease.
import { readJson, writeJson } from "../lib/http";
import { ensemblSites } from "./ensembl";

async function main() {
  const cv = readJson<{ rows: unknown[][] }>("pipeline/out/clinvar-bulk.json");
  const bundle = readJson<{ clinvar: { rsid: string }[] }>("src/evidence/bundle.json");
  const rsids = [...new Set([...cv.rows.map((r) => `rs${r[0]}`), ...bundle.clinvar.map((r) => r.rsid)])];
  console.log(`ClinVar rsIDs: ${rsids.length.toLocaleString()}`);
  const ens = await ensemblSites(rsids);
  // rsid → [minor allele, global minor-allele frequency, all alleles "REF/ALT1/ALT2"]
  const freq: Record<string, [string, number, string]> = {};
  // Known to Ensembl but with no 1000 Genomes frequency: not observed there, i.e. rare worldwide. Stored as ["", 0, alleles].
  for (const [id, s] of ens) freq[id] = s.minor && s.maf != null ? [s.minor, s.maf, [s.ref, ...s.alts].join("/")] : ["", 0, [s.ref, ...s.alts].join("/")];
  writeJson("pipeline/out/clinvar-freq.json", { source: "Ensembl GRCh37 REST (1000 Genomes phase 3 global MAF)", retrievedAt: new Date().toISOString().slice(0, 10), freq });
  console.log(`frequencies for ${Object.keys(freq).length.toLocaleString()} of ${rsids.length.toLocaleString()} rsIDs`);
}
main().catch((e) => { console.error(e); process.exit(1); });

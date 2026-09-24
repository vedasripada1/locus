// Plain definitions for GWAS traits from the Experimental Factor Ontology (EBI OLS4 API),
// for every trait with at least one well-replicated (≥3 concordant publications) association.
import { get, readJson, writeJson } from "../lib/http";

async function main() {
  const g = readJson<{ traits: [string, string, string, string][]; groups: unknown[][] }>("pipeline/out/gwas-bulk.json");
  const idx = new Set(g.groups.filter((r) => (r[11] as number) >= 3).map((r) => r[1] as number));
  const defs: Record<string, string> = {};
  let n = 0;
  for (const i of idx) {
    const uri = g.traits[i][1];
    try {
      const c = await get<any>(`https://www.ebi.ac.uk/ols4/api/ontologies/efo/terms?iri=${encodeURIComponent(uri)}`);
      const d = c.body?._embedded?.terms?.[0]?.description?.[0];
      if (d) defs[uri] = String(d).replace(/\s+/g, " ").trim().slice(0, 600);
    } catch { /* leave undefined: the app shows no definition rather than a guess */ }
    if (++n % 100 === 0) console.log(`  efo ${n} / ${idx.size}`);
  }
  writeJson("pipeline/out/efo-defs.json", { retrievedAt: new Date().toISOString().slice(0, 10), source: "EFO via EBI OLS4", defs });
  console.log(`definitions for ${Object.keys(defs).length} of ${idx.size} traits`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Titles/journal/year/first author for every PMID referenced by the bulk tiers
// (ClinVar citations; GWAS papers come with metadata in the catalog file itself).
// PubMed esummary, 200 ids per call, cached; ~3 requests/s without an API key.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get, CACHE } from "../lib/http";

const STORE = join(CACHE, "papers.json"); // per-PMID cache so batches can change between runs

export type Paper = [title: string, firstAuthor: string, journal: string, year: string];

export async function paperMeta(pmids: number[]): Promise<Record<string, Paper>> {
  const store: Record<string, Paper> = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {};
  const missing = [...new Set(pmids)].filter((p) => !(p in store)).sort((a, b) => a - b);
  await fetchInto(store, missing);
  writeFileSync(STORE, JSON.stringify(store));
  return Object.fromEntries([...new Set(pmids)].filter((p) => p in store).map((p) => [p, store[p]]));
}

async function fetchInto(out: Record<string, Paper>, ids: number[]) {
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const c = await get<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${batch.join(",")}`);
    const r = c.body.result ?? {};
    for (const id of r.uids ?? []) {
      const d = r[id];
      if (!d || d.error) continue;
      out[id] = [String(d.title ?? "").replace(/\s+/g, " ").trim(), d.sortfirstauthor ?? d.authors?.[0]?.name ?? "", d.source ?? "", String(d.pubdate ?? "").slice(0, 4)];
    }
    if ((i / 200) % 50 === 0) {
      console.log(`  pubmed ${Math.min(i + 200, ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`);
      writeFileSync(STORE, JSON.stringify(out)); // checkpoint
    }
  }
}

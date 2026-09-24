// Forward-strand alleles (GRCh38 allele_string, ref first) and GRCh37 positions for bulk
// GWAS sites, via Ensembl REST batch lookups (POST /variation/homo_sapiens, 200 ids per call).
// Ensembl allows 15 requests/s; we send ≤4/s and cache every batch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/http";

const CACHE = join(ROOT, "pipeline/cache/ensembl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EnsemblSite { ref: string; alts: string[]; chrom: string; pos38: number | null; pos37: number | null; maf: number | null; minor: string | null }

async function post(host: string, ids: string[], tries = 5): Promise<Record<string, any>> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(`${host}/variation/homo_sapiens`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ids }), signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) { await sleep(Number(res.headers.get("retry-after") ?? 2) * 1000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1500 * i);
    }
  }
}

export async function ensemblSites(rsids: string[]): Promise<Map<string, EnsemblSite>> {
  mkdirSync(CACHE, { recursive: true });
  const out = new Map<string, EnsemblSite>();
  const sorted = [...new Set(rsids)].sort();
  const B = 200, CONCURRENCY = Number(process.env.ENSEMBL_CONCURRENCY ?? 8);
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += B) batches.push(sorted.slice(i, i + B));
  let done = 0;
  // GRCh37 server only: it is ~8x faster than the GRCh38 one, and GRCh37 is the build
  // consumer files use. allele_string is forward-strand, reference allele first.
  const run = async (ids: string[]) => {
    const file = join(CACHE, `${ids[0]}_${ids.length}_${ids[ids.length - 1]}.json`);
    let g37: Record<string, any>;
    if (existsSync(file)) g37 = JSON.parse(readFileSync(file, "utf8"));
    else { g37 = await post("https://grch37.rest.ensembl.org", ids); writeFileSync(file, JSON.stringify(g37)); await sleep(100); }
    for (const id of ids) {
      const v = g37[id];
      const m = v?.mappings?.find((x: any) => x.coord_system === "chromosome" && /^([0-9]+|X|Y|MT)$/.test(x.seq_region_name));
      if (!m) continue;
      const alleles = String(m.allele_string).split("/");
      if (alleles.length < 2 || !alleles.every((a) => /^[ACGT-]+$/.test(a))) continue;
      out.set(id, { ref: alleles[0], alts: alleles.slice(1), chrom: m.seq_region_name, pos38: null, pos37: m.start ?? null, maf: v.MAF ?? null, minor: v.minor_allele ?? null });
    }
    if (++done % 50 === 0) console.log(`  ensembl ${done} / ${batches.length} batches`);
  };
  // Worker pool: each worker takes the next batch as soon as it is free (no lockstep waits).
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < batches.length) await run(batches[next++]); }));
  return out;
}

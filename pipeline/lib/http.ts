// Polite, cached HTTP for the evidence pipeline. Every response is stored with
// its URL and retrieval time under pipeline/cache/, so a build is auditable and
// re-running it does not hammer the sources.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CACHE = join(ROOT, "pipeline", "cache");

export interface Cached<T> { url: string; retrievedAt: string; body: T }

const NCBI_KEY = process.env.NCBI_API_KEY;
const NCBI_EMAIL = process.env.NCBI_EMAIL;
// NCBI: 3 req/s without a key, 10 with one. GWAS Catalog / ClinGen: be gentle.
const MIN_GAP_MS: Record<string, number> = { ncbi: NCBI_KEY ? 110 : 350, ebi: 300, clingen: 1000, web: 1000 };
const last: Record<string, number> = {};

function host(url: string) {
  if (url.includes("ncbi.nlm.nih.gov")) return "ncbi";
  if (url.includes("ebi.ac.uk")) return "ebi";
  if (url.includes("clinicalgenome.org")) return "clingen";
  return "web";
}

export function withNcbiParams(url: string) {
  const u = new URL(url);
  u.searchParams.set("tool", "locus-evidence-pipeline");
  if (NCBI_EMAIL) u.searchParams.set("email", NCBI_EMAIL);
  if (NCBI_KEY) u.searchParams.set("api_key", NCBI_KEY);
  return u.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maxAgeDays = Number(process.env.CACHE_MAX_AGE_DAYS ?? 30);

export async function get<T = unknown>(url: string, kind: "json" | "text" = "json", tries = 4): Promise<Cached<T>> {
  const file = join(CACHE, host(url), createHash("sha1").update(url).digest("hex") + ".json");
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, "utf8")) as Cached<T>;
    if ((Date.now() - Date.parse(c.retrievedAt)) / 86400e3 < maxAgeDays) return c;
  }
  const h = host(url);
  const fetchUrl = h === "ncbi" ? withNcbiParams(url) : url;
  for (let attempt = 1; ; attempt++) {
    const wait = (last[h] ?? 0) + MIN_GAP_MS[h] - Date.now();
    if (wait > 0) await sleep(wait);
    last[h] = Date.now();
    try {
      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(180_000), headers: { "User-Agent": "locus-evidence-pipeline/0.1" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true });
      const body = (kind === "json" ? await res.json() : await res.text()) as T;
      const c: Cached<T> = { url, retrievedAt: new Date().toISOString(), body }; // key-free URL is stored
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(c));
      return c;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || attempt >= tries) throw e;
      console.warn(`  retry ${attempt} ${url}: ${(e as Error).message}`);
      await sleep(2000 * attempt);
    }
  }
}

export const today = () => new Date().toISOString().slice(0, 10);
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
export const writeJson = (p: string, v: unknown) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), JSON.stringify(v, null, 1) + "\n");
};

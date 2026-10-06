// Stage 1d — supplements & your DNA.
// Verifies the curated supplement guide (pipeline/seeds/supplements.json) and maps the literature:
//  1. every quote (general evidence, upper limit, cautions) is found verbatim in its PubMed abstract or web page;
//  2. every number in the plain texts appears in one of the entry's verified quotes;
//  3. every linked gene guide entry, marketed site and intervention exists in its own seed;
//  4. for each supplement × gene, PubMed is searched for records about genetic variants, counting all
//     records, trials and reviews, and the top trials are screened like every literature candidate.
// The literature map is a reading list with counts; no claim in the app is derived from it.
// Anything that fails verification is dropped and logged. Output: pipeline/out/supplements.json
import { readJson, writeJson, today } from "./lib/http";
import { fetchRecords, searchCount } from "./lib/pubmed";
import { orphanNumbers, sourceTexts, verifyQuotes, type SeedQuote } from "./genes";
import { screen } from "./literature";
import type { AuditEntry, SupplementEntry, SupplementGenePair, SupplementGuide } from "../src/core/types";

export interface SeedEntry extends Omit<SupplementEntry, "general" | "safety" | "map"> {
  general: SeedQuote[];
  safety: { upperLimit: SeedQuote | null; cautions: SeedQuote[] };
  mine: { terms: string; genes: string[] };
}
interface Seed { variantTerms: string; trialFilter: string; reviewFilter: string; screenTop: number; supplements: SeedEntry[] }

/** PubMed query for one supplement × gene, restricted to records about genetic variants. */
export function pairQuery(seed: Pick<Seed, "variantTerms">, terms: string, gene: string): string {
  return `(${terms}) AND (${gene}[tiab]) AND ${seed.variantTerms}`;
}

async function mapPair(seed: Seed, s: SeedEntry, gene: string): Promise<SupplementGenePair> {
  const query = pairQuery(seed, s.mine.terms, gene);
  const total = await searchCount(query);
  const trials = await searchCount(`${query} AND ${seed.trialFilter}`, seed.screenTop);
  const reviews = await searchCount(`${query} AND ${seed.reviewFilter}`);
  const screened = (await fetchRecords(trials.ids)).map((r) => screen(r, s.id, `${s.name} × ${gene}`));
  return {
    gene, total: total.count, trials: trials.count, reviews: reviews.count, screened,
    humanInteraction: screened.filter((c) => c.humans && c.mentionsGeneInteraction).length, query,
  };
}

type Texts = Awaited<ReturnType<typeof sourceTexts>>;
export interface Known { genes: Set<string>; marketed: Set<string>; interventions: Set<string> }

/**
 * Verify one supplement against fetched source texts (no network). Returns the entry without its
 * literature map, or null when it is dropped. Unknown cross-references are curation errors and throw.
 */
export function verifySupplement(s: SeedEntry, texts: Texts, known: Known, audit: AuditEntry[]): Omit<SupplementEntry, "map"> | null {
  const subject = `supplement ${s.id}`;
  const bad = [...s.genes.filter((g) => !known.genes.has(g)).map((g) => `gene guide entry ${g}`),
    ...s.marketed.filter((r) => !known.marketed.has(r)).map((r) => `marketed site ${r}`),
    ...s.interventions.filter((i) => !known.interventions.has(i)).map((i) => `intervention ${i}`)];
  if (bad.length) throw new Error(`${subject}: unknown ${bad.join(", ")}`);

  const general = verifyQuotes(subject, s.general, texts, audit);
  if (!general?.length) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: "No verified general evidence remained." }); return null; }
  // Safety quotes are verified one by one, so a failing caution never takes the whole card with it.
  const one = (q: SeedQuote | null, what: string) => (q ? verifyQuotes(`${subject} / ${what}`, [q], texts, audit)?.[0] ?? null : null);
  const upperLimit = one(s.safety.upperLimit, "upper limit");
  const cautions = s.safety.cautions.map((q) => one(q, "caution")).filter((q) => q != null);

  const orphans = orphanNumbers([s.what, s.generalNote], [...general, ...(upperLimit ? [upperLimit] : []), ...cautions], [s.name, ...s.aliases]);
  if (orphans.length) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: `numbers not in any verified quote: ${orphans.join(", ")}` }); return null; }
  const { mine: _m, ...rest } = s;
  audit.push({ stage: "verify", subject, outcome: "ok",
    detail: `${general.length} general quote(s), ${upperLimit ? "upper limit" : "no upper limit"}, ${cautions.length} caution(s) verified.` });
  return { ...rest, general, safety: { upperLimit, cautions } };
}

export async function buildSupplements(seed: Seed, audit: AuditEntry[]): Promise<SupplementGuide> {
  const genes = readJson<{ genes: { id: string }[]; unsupported: { rsid: string }[] }>("pipeline/seeds/genes.json");
  const interventions = readJson<{ interventions: { id: string }[] }>("pipeline/seeds/interventions.json").interventions;
  const known: Known = { genes: new Set(genes.genes.map((g) => g.id)), marketed: new Set(genes.unsupported.map((u) => u.rsid)), interventions: new Set(interventions.map((i) => i.id)) };
  const quotesOf = (s: SeedEntry) => [...s.general, ...(s.safety.upperLimit ? [s.safety.upperLimit] : []), ...s.safety.cautions];
  const texts = await sourceTexts(seed.supplements.flatMap(quotesOf).map((q) => q.ref));

  const entries: SupplementEntry[] = [];
  for (const s of seed.supplements) {
    const verified = verifySupplement(s, texts, known, audit);
    if (!verified) continue;
    const map: SupplementGenePair[] = [];
    for (const g of s.mine.genes) map.push(await mapPair(seed, s, g));
    entries.push({ ...verified, map });
  }
  return { builtAt: today(), entries };
}

async function main() {
  const seed = readJson<Seed>("pipeline/seeds/supplements.json");
  const audit: AuditEntry[] = [];
  const guide = await buildSupplements(seed, audit);
  writeJson("pipeline/out/supplements.json", { guide, audit });
  console.log(`supplements: ${guide.entries.length}/${seed.supplements.length} verified`);
  for (const e of guide.entries) console.log(`  ${e.id}: ${e.map.map((m) => `${m.gene} ${m.total} records, ${m.trials} trials, ${m.reviews} reviews, ${m.humanInteraction}/${m.screened.length} screened trials report a genotype interaction`).join("; ")}`);
  for (const a of audit.filter((x) => x.outcome === "dropped")) console.log(`  DROPPED ${a.subject}: ${a.detail}`);
}

if (process.argv[1]?.endsWith("supplements.ts")) main().catch((e) => { console.error(e); process.exit(1); });

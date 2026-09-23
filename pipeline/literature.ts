// Stage 1b — literature retrieval.
//  (a) Runs PubMed queries per topic and stores auto-classified CANDIDATES.
//      Candidates are shown as a reading list; no claims are derived from them.
//  (b) Fetches the text of every reference cited in seeds/interventions.json
//      (PubMed abstract, PMC full text, or web page) so build.ts can verify quotes.
import { get, readJson, writeJson } from "./lib/http";
import { classifyDesign, fetchPmcText, fetchRecords, search, stripTags, type PubmedRecord } from "./lib/pubmed";
import type { LiteratureCandidate, SourceVersion } from "../src/core/types";

interface LitSeeds { design: string; topics: { id: string; intervention: string; geneDiet: string }[] }
const seeds = readJson<LitSeeds>("pipeline/seeds/literature.json");
const interventions = readJson<{ interventions: any[] }>("pipeline/seeds/interventions.json").interventions;
const warnings = readJson<{ warnings: any[] }>("pipeline/seeds/warnings.json").warnings;

const HUMAN_WORDS = /\b(patients?|participants?|subjects|volunteers|adults|children|women|men|individuals|cohort|humans?)\b/i;
const ANIMAL_WORDS = /\b(mice|mouse|murine|rats?|rodents?|piglets?|zebrafish|drosophila|in vivo model)\b/i;
const IN_VITRO = /\b(in vitro|cell line|cultured cells|HepG2|Caco-2|hepatocytes? cultures?)\b/i;
const GXE = /(gene[- ](diet|nutrient|environment|by)|genotype[- ]by|interaction|effect modification|modif(y|ied|ies)|stratified by genotype|according to genotype|by genotype|carriers? (of|vs)|differ\w* (by|between) genotypes?)/i;

export function screen(r: PubmedRecord, topic: string, query: string): LiteratureCandidate {
  const text = `${r.title}\n${r.abstract}`;
  const indexed = r.mesh.length > 0;
  const meshHumans = r.mesh.includes("Humans");
  const meshAnimals = r.mesh.includes("Animals");
  const flags: string[] = [];
  let humans = meshHumans;
  let animalOnly = meshAnimals && !meshHumans;
  if (!indexed) {
    flags.push("not yet MeSH-indexed: species inferred from abstract text");
    humans = HUMAN_WORDS.test(text);
    animalOnly = ANIMAL_WORDS.test(text) && !humans;
  }
  if (animalOnly) flags.push("animal-only: not evidence of effect in humans");
  if (IN_VITRO.test(text) && !humans) flags.push("mechanistic / in vitro only: unsupported for human outcomes");
  if (!r.abstract) flags.push("no abstract available");
  const n = text.match(/\b[nN]\s*=\s*(\d[\d,\s]*\d|\d)\b/) ?? text.match(/\b(\d{2,3}(?:,\d{3})+|\d{2,7})\s+(?:participants|patients|subjects|adults|individuals|women|men|children|athletes)\b/);
  const sampleSize = n ? { value: n[1].replace(/\s/g, ""), snippet: text.slice(Math.max(0, n.index! - 60), n.index! + n[0].length + 40).replace(/\s+/g, " ") } : null;
  return {
    pmid: r.pmid, doi: r.doi, title: r.title, journal: r.journal, year: r.year, publicationTypes: r.publicationTypes,
    design: classifyDesign(r.publicationTypes, r.mesh), humans, animalOnly,
    mentionsGeneInteraction: GXE.test(r.abstract) && /(genotype|allele|polymorphism|variant|rs\d+)/i.test(r.abstract),
    sampleSize, flags, topic, query, url: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`, source: r.source,
  };
}

export interface SourceText { key: string; kind: "pmid" | "pmcid" | "url"; title: string; text: string; record?: PubmedRecord; source: SourceVersion }

async function main() {
  // (a) candidates
  const candidates: LiteratureCandidate[] = [];
  for (const t of seeds.topics) {
    for (const [label, q] of [["intervention", `(${t.intervention}) AND ${seeds.design}`], ["gene-diet", t.geneDiet]] as const) {
      const ids = await search(q, 8);
      const recs = await fetchRecords(ids);
      for (const r of recs) if (!candidates.some((c) => c.pmid === r.pmid && c.topic === t.id)) candidates.push(screen(r, t.id, `${label}: ${q}`));
      console.log(`  ${t.id} ${label}: ${recs.length}`);
    }
  }

  // (b) curated reference texts
  const refs = new Map<string, { pmid?: string; pmcid?: string; url?: string }>();
  const key = (r: { pmid?: string; pmcid?: string; url?: string }) => (r.pmid ? `pmid:${r.pmid}` : r.pmcid ? `pmcid:${r.pmcid}` : `url:${r.url}`);
  for (const iv of interventions) {
    for (const s of iv.studies) refs.set(key(s.ref), s.ref);
    const safety = iv.safety ? [iv.safety.upperLimit, ...iv.safety.adverseEffects, ...iv.safety.interactions].filter(Boolean) : [];
    for (const q of safety) refs.set(key(q.ref), q.ref);
    for (const f of iv.contextFlags) if (f.evidence) refs.set(key(f.evidence.ref), f.evidence.ref);
  }
  for (const w of warnings) refs.set(key(w.ref), w.ref);
  const texts: SourceText[] = [];
  const pmids = [...refs.values()].filter((r) => r.pmid).map((r) => r.pmid!);
  for (const r of await fetchRecords(pmids)) {
    texts.push({ key: `pmid:${r.pmid}`, kind: "pmid", title: r.title, text: `${r.title}\n${r.abstract}`, record: r, source: r.source });
  }
  for (const r of refs.values()) {
    if (r.pmcid) {
      const p = await fetchPmcText(r.pmcid);
      texts.push({ key: `pmcid:${r.pmcid}`, kind: "pmcid", title: p.title, text: p.text, source: p.source });
    } else if (r.url) {
      try {
        const c = await get<string>(r.url, "text");
        const title = c.body.match(/<title>([^<]*)/)?.[1]?.trim() ?? r.url;
        const current = stripTags(c.body).match(/Content current as of:\s*([\d/]+)/)?.[1];
        texts.push({ key: `url:${r.url}`, kind: "url", title, text: stripTags(c.body),
          source: { source: "Web", version: current ? `page dated ${current}` : "undated page", retrievedAt: c.retrievedAt.slice(0, 10), url: r.url } });
      } catch (e) {
        console.warn(`  could not fetch ${r.url}: ${(e as Error).message} (claims citing it will be dropped)`);
      }
    }
  }
  writeJson("pipeline/out/literature.json", { candidates, texts });
  console.log(`wrote pipeline/out/literature.json: ${candidates.length} candidates, ${texts.length}/${refs.size} reference texts`);
}

if (process.argv[1]?.endsWith("literature.ts")) main().catch((e) => { console.error(e); process.exit(1); });

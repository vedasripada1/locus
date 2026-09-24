// Stage 2 — verification and bundle build.
// Joins retrieved source records with curated seeds and verifies every quoted
// claim against the fetched source text. Anything that fails is DROPPED and
// written to the audit log, never silently kept.
import { readJson, writeJson } from "./lib/http";
import { classifyDesign } from "./lib/pubmed";
import { screen, type SourceText } from "./literature";
import type {
  AuditEntry, EvidenceBundle, Intervention, InterventionStudy, LiteratureCandidate, Quoted, SourcedQuote, SourceVersion, TraitTopic,
} from "../src/core/types";

type Ref = { pmid?: string; pmcid?: string; url?: string };
const refKey = (r: Ref) => (r.pmid ? `pmid:${r.pmid}` : r.pmcid ? `pmcid:${r.pmcid}` : `url:${r.url}`);

/** Normalise for quote matching: unicode, quotes, dashes, whitespace, case. */
export function norm(s: string): string {
  return s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}
/** Standalone numbers (not parts of names like B12, D3, rs671), thousands separators removed. */
const numbers = (s: string) =>
  (norm(s).replace(/(\d)[,\s](?=\d{3}\b)/g, "$1").match(/(?<![a-z\d.])\d+(?:\.\d+)?/g) ?? []).map(Number);

/** A quote must occur in the source; every number in the value must occur in the quote. */
export function verifyQuoted(q: Quoted, sourceText: string): string | null {
  if (!norm(sourceText).includes(norm(q.quote))) return `quote not found in source: "${q.quote.slice(0, 80)}…"`;
  const inQuote = new Set(numbers(q.quote));
  // Numeric equality, so "34" matches "34.0".
  const missing = numbers(q.value).filter((n) => !inQuote.has(n));
  return missing.length ? `value "${q.value}" has numbers not in its quote: ${missing.join(", ")}` : null;
}

/** "Author et al., Journal Year" (author omitted when PubMed has no usable name). */
export function cite(r: { firstAuthor: string; journal: string; year: string }): string {
  return `${r.firstAuthor ? `${r.firstAuthor} et al., ` : ""}${r.journal} ${r.year}`;
}

export function buildInterventions(seed: any[], texts: Map<string, SourceText>, audit: AuditEntry[]): Intervention[] {
  const out: Intervention[] = [];
  for (const iv of seed) {
    const studies: (InterventionStudy & { role: string })[] = [];
    for (const s of iv.studies) {
      const src = texts.get(refKey(s.ref));
      const subject = `${iv.id} / ${refKey(s.ref)}`;
      if (!src) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: "Source could not be retrieved." }); continue; }
      const fields: Quoted[] = [s.sampleSize, s.population, s.exposure, s.harms, ...s.outcomes].filter(Boolean);
      const errors = fields.map((f) => verifyQuoted(f, src.text)).filter(Boolean);
      if (errors.length) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: errors.join("; ") }); continue; }
      const r = src.record;
      const cand = r ? screen(r, iv.id, "curated") : null;
      studies.push({
        role: s.role, ref: s.ref,
        citation: r ? cite(r) : src.title,
        title: src.title, doi: r?.doi ?? null,
        design: r ? classifyDesign(r.publicationTypes, r.mesh) : "other",
        sampleSize: s.sampleSize, population: s.population, exposure: s.exposure, outcomes: s.outcomes, harms: s.harms,
        humans: cand ? cand.humans || (r!.book && /patients|individuals|women|heterozygotes/i.test(r!.abstract)) : false,
        genotypeInteraction: s.genotypeInteraction, source: src.source,
      });
      audit.push({ stage: "verify", subject, outcome: "ok", detail: `${fields.length} quoted field(s) verified.` });
    }

    let safety: Intervention["safety"] = null;
    if (iv.safety) {
      const verifySafety = (q: any, what: string): SourcedQuote | null => {
        if (!q) return null;
        const src = texts.get(refKey(q.ref));
        const err = src ? verifyQuoted(q, src.text) : "source could not be retrieved";
        if (err) { audit.push({ stage: "verify", subject: `${iv.id} / ${what}`, outcome: "dropped", detail: err }); return null; }
        return { value: q.value, quote: q.quote, source: src!.source, citation: src!.record ? cite(src!.record) : src!.title };
      };
      safety = {
        upperLimit: verifySafety(iv.safety.upperLimit, "upper limit"),
        adverseEffects: iv.safety.adverseEffects.map((q: any) => verifySafety(q, "adverse effect")).filter(Boolean),
        interactions: iv.safety.interactions.map((q: any) => verifySafety(q, "interaction")).filter(Boolean),
      };
    }

    if (!studies.length) {
      audit.push({ stage: "build", subject: iv.id, outcome: "dropped", detail: "No verified evidence remained." });
      continue;
    }
    if (iv.type === "supplement") {
      const direct = studies.some((s) => s.humans && ["meta-analysis", "systematic review", "randomized controlled trial"].includes(s.design));
      if (!direct || !safety?.upperLimit) {
        audit.push({ stage: "build", subject: iv.id, outcome: "dropped",
          detail: `Supplement excluded: ${!direct ? "no verified human RCT/meta-analysis" : "no verified upper limit"}.` });
        continue;
      }
    }
    // Plain-language summaries are hand-written, so every number in them must appear in a verified quote.
    const quoted = [...studies.flatMap((x) => [x.sampleSize, x.population, x.exposure, x.harms, ...x.outcomes]), safety?.upperLimit, ...(safety?.adverseEffects ?? []), ...(safety?.interactions ?? [])]
      .filter(Boolean).map((q) => (q as Quoted).quote).join(" ");
    const orphan = numbers(iv.summary).filter((n) => !numbers(quoted).includes(n) && !numbers(iv.name).includes(n));
    if (orphan.length) throw new Error(`${iv.id}: summary numbers not found in its verified quotes: ${orphan.join(", ")}`);
    const strip = ({ role: _r, ...s }: InterventionStudy & { role: string }) => s;
    out.push({
      id: iv.id, triggers: iv.triggers, triggerNote: iv.triggerNote, name: iv.name, type: iv.type, summary: iv.summary,
      generalEvidence: studies.filter((s) => s.role === "general").map(strip),
      genotypeEvidence: studies.filter((s) => s.role === "genotype").map(strip),
      safety, limitations: iv.limitations, contextFlags: verifyFlags(iv, texts, audit),
    });
  }
  return out;
}

/** Context flags that cite a study keep only if their quote verifies. */
function verifyFlags(iv: any, texts: Map<string, SourceText>, audit: AuditEntry[]) {
  return iv.contextFlags.flatMap((f: any) => {
    if (!f.evidence) return [f];
    const src = texts.get(refKey(f.evidence.ref));
    const err = src ? verifyQuoted({ value: "", quote: f.evidence.quote }, src.text) : "source could not be retrieved";
    if (err) { audit.push({ stage: "verify", subject: `${iv.id} / context flag`, outcome: "dropped", detail: err }); return []; }
    const r = src!.record;
    return [{ ...f, evidence: { value: "", quote: f.evidence.quote, source: src!.source, citation: r ? cite(r) : src!.title } }];
  });
}

function main() {
  const v = readJson<any>("pipeline/out/variants.json");
  const lit = readJson<{ candidates: LiteratureCandidate[]; texts: SourceText[] }>("pipeline/out/literature.json");
  const seedIv = readJson<{ interventions: any[] }>("pipeline/seeds/interventions.json").interventions;
  const audit: AuditEntry[] = [...v.audit];
  const texts = new Map(lit.texts.map((t) => [t.key, t]));
  const interventions = buildInterventions(seedIv, texts, audit);

  const warnings = readJson<{ warnings: any[] }>("pipeline/seeds/warnings.json").warnings.flatMap((w) => {
    const src = texts.get(refKey(w.ref));
    const errs = src ? w.quotes.map((q: string) => verifyQuoted({ value: "", quote: q }, src.text)).filter(Boolean) : ["source could not be retrieved"];
    if (errs.length) { audit.push({ stage: "verify", subject: `warning ${w.id}`, outcome: "dropped", detail: errs.join("; ") }); return []; }
    const r = src!.record;
    const citation = r ? cite(r) : src!.title;
    return [{ id: w.id, title: w.title, summary: w.summary, quotes: w.quotes.map((q: string) => ({ value: "", quote: q, source: src!.source, citation })) }];
  });

  const traits: TraitTopic[] = v.topics.map((t: any) => ({
    id: t.id, label: t.label, phrase: t.phrase, domain: t.domain, rsids: t.rsids, traitPattern: t.traitPattern, reportedPattern: t.reportedPattern,
    description: t.description, absoluteRiskBaseline: null,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const sources: SourceVersion[] = [
    ...v.sources,
    { source: "PubMed", version: `E-utilities; ${lit.candidates.length} candidate records, ${lit.texts.filter((t) => t.kind === "pmid").length} curated abstracts`, retrievedAt: today, url: "https://pubmed.ncbi.nlm.nih.gov/" },
    ...lit.texts.filter((t) => t.kind !== "pmid").map((t) => t.source),
  ];
  const bundle: EvidenceBundle = {
    schemaVersion: 1, builtAt: new Date().toISOString(), sources, sites: v.sites, clinvar: v.clinvar, clingen: v.clingen, gwas: v.gwas,
    traits, interventions, literature: lit.candidates, audit, warnings,
  };
  writeJson("src/evidence/bundle.json", bundle);
  const dropped = audit.filter((a) => a.outcome === "dropped");
  console.log(`bundle: ${bundle.sites.length} sites, ${bundle.clinvar.length} ClinVar, ${bundle.gwas.length} GWAS, ${interventions.length}/${seedIv.length} interventions, ${bundle.literature.length} literature candidates`);
  for (const d of dropped) console.log(`  DROPPED ${d.subject}: ${d.detail}`);
}

if (process.argv[1]?.endsWith("build.ts")) main();

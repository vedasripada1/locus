// Plain-language summary. Turns the technical Report into short, readable items
// ("confirm with a doctor", "things you could do", "good to know", "checked and not found").
// Every sentence is a fixed template filled with values already in the Report; no new
// claims are introduced here. Size words for odds ratios follow a fixed, documented rubric.
import type { ClinicalFinding, ClinGenValidity, GwasFinding, InterventionAssessment, Report } from "./types";
import type { BulkGwasHit } from "./bulk";
import { classifyClinVar } from "./interpret";

export type Tone = "confirm" | "action" | "know" | "clear" | "quality";
export type Category = "diet" | "supplement" | "lifestyle" | "clinician" | "health" | "medication" | "trait" | "clear" | "quality";

/**
 * What counts as sufficient evidence to show an item by default. Items below the bar are
 * hidden unless the user asks for weaker evidence (and always remain in the appendix).
 */
export const SUFFICIENT_RULES: Record<Category, string> = {
  diet: "A human randomized trial, meta-analysis, systematic review or clinical guideline supports it.",
  supplement: "A human randomized trial, meta-analysis or systematic review supports it, and a verified upper limit exists.",
  lifestyle: "A human randomized trial, meta-analysis, systematic review or clinical guideline supports it.",
  clinician: "A clinical guideline, randomized trial, meta-analysis or systematic review supports it.",
  health: "ClinVar classifies the variant pathogenic with at least 2 review stars.",
  medication: "A ClinVar expert panel (3+ review stars) classifies the drug response.",
  trait: "At least 3 publications agree on the direction, with no substantial disagreement.",
  clear: "Always shown (it reports what was tested).",
  quality: "Always shown.",
};
const STRONG_DESIGNS = ["guideline", "meta-analysis", "systematic review", "randomized controlled trial"];
export type Confidence = "higher" | "moderate" | "low";

export interface SummaryItem {
  id: string;
  tone: Tone;
  category: Category;
  /** Meets the SUFFICIENT_RULES bar for its category. */
  sufficient: boolean;
  /** Short label for the evidence behind it, e.g. "Meta-analysis" or "ClinVar 2★". */
  evidenceLabel: string;
  /** One line: why this may apply to you. */
  whyYou: string;
  /** One line: does your DNA change the advice? (actions only) */
  dnaMatters?: string;
  /** One line: the most important limit or caution (actions only). */
  caution?: string;
  /** Whether you carry the relevant allele (false for "checked and not found"). */
  carried: boolean;
  title: string;
  /** One or two sentences a non-specialist can read. */
  plain: string;
  /** Rationale: why this item is shown, and what the evidence is. */
  why: string[];
  /** What a reasonable next step is (never "start/stop medication"). */
  next: string[];
  confidence: Confidence;
  /** Optional list of sub-points (e.g. several flagged variants). */
  list?: string[];
  /** Where the technical detail lives in the appendix. */
  appendix: { section: string; query?: string };
  sources: { label: string; url: string }[];
  sensitive?: boolean;
}

export interface Summary { headline: string; items: SummaryItem[] }

// ─── Wording helpers ────────────────────────────────────────────────────────

/** Fixed rubric for a per-copy odds ratio (relative effect only; never absolute risk). */
export function orSize(or: number): "very small" | "small" | "moderate" | "large" {
  const x = or >= 1 ? or : 1 / or;
  if (x >= 3) return "large";
  if (x >= 1.5) return "moderate";
  if (x >= 1.15) return "small";
  return "very small";
}

/** Adverb form of the rubric for sentences: "slightly higher odds". */
export const orAdverb = (or: number) => ({ "very small": "very slightly", small: "slightly", moderate: "moderately", large: "much" })[orSize(or)];

const copies = (n: number) => `${n} cop${n === 1 ? "y" : "ies"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const MOI_PLAIN: Record<string, string> = {
  AR: "recessive: it usually takes two copies (one from each parent) to cause the condition",
  AD: "dominant: one copy can be enough to raise the chance of the condition",
  XL: "X-linked: effects differ between males and females",
  XLR: "X-linked recessive: mainly affects males",
  XLD: "X-linked dominant",
  SD: "semidominant: one copy can have an effect and two copies a larger one",
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const overlaps = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());

/** ClinGen curations for a condition: exact name match first, then name overlap. */
function curationsFor(f: Pick<ClinicalFinding, "clingen">, cond: string): ClinGenValidity[] {
  const exact = f.clingen.filter((g) => same(g.disease, cond));
  return exact.length ? exact : f.clingen.filter((g) => overlaps(g.disease, cond));
}

/**
 * The inheritance pattern ClinGen gives for the named condition (or, without one, for all the
 * finding's conditions) when it is unambiguous; null otherwise.
 */
export function inheritance(f: Pick<ClinicalFinding, "clingen" | "record">, cond?: string): string | null {
  const pool = cond ? curationsFor(f, cond) : f.clingen.filter((g) => f.record.conditions.some((c) => overlaps(g.disease, c)));
  // No curation for this condition: fall back to the gene, which only helps if all its curations agree.
  const mois = [...new Set((pool.length ? pool : f.clingen).map((g) => g.moi).filter((m) => m in MOI_PLAIN))];
  return mois.length === 1 ? mois[0] : null;
}

const GENERIC = /^(inborn genetic diseases|hereditary cancer-predisposing syndrome)$/i;

/** The condition to name: ClinVar-pathogenic (≥2★ per condition), preferring one ClinGen curates by exact name. */
function mainCondition(f: ClinicalFinding): string {
  const pathogenicFor = classifyClinVar(f.record).conditions.filter((c) => !GENERIC.test(c));
  const pool = pathogenicFor.length ? pathogenicFor : f.record.conditions.filter((c) => !GENERIC.test(c));
  return pool.find((c) => f.clingen.some((g) => same(g.disease, c))) ?? pool.find((c) => f.clingen.some((g) => overlaps(g.disease, c))) ?? pool[0] ?? `a condition linked to ${f.match.site.gene}`;
}

/** Plain statement of what ClinVar says, citing the per-condition call when the overall label differs. */
function clinvarWhy(f: ClinicalFinding, cond: string): string {
  const r = f.record;
  const rcv = r.rcvs.filter((x) => same(x.condition, cond) && /pathogenic/i.test(x.classification) && !/conflicting/i.test(x.classification)).sort((a, b) => b.stars - a.stars)[0];
  if (rcv && !/pathogenic/i.test(r.classification)) {
    return `ClinVar classifies ${r.title} as "${rcv.classification}" for ${cond} (${rcv.stars}/4 review stars: ${rcv.reviewStatus}; ${rcv.rcv}). Its overall label is "${r.classification}", which is a separate expert-panel call.`;
  }
  return `ClinVar classifies ${r.title} as "${r.classification}" (${r.stars}/4 review stars: ${r.reviewStatus}).`;
}

// ─── Item builders ──────────────────────────────────────────────────────────

export function confirmItem(f: ClinicalFinding, bulk = false): SummaryItem {
  const r = f.record;
  const cond = mainCondition(f);
  const moi = inheritance(f, cond);
  const two = f.zygosity === "homozygous";
  const lowPen = /low penetrance/i.test(r.classification);
  let plain: string;
  if (moi === "AR" && !two) plain = `You appear to carry one copy of a variant that causes ${cond} when someone has two copies. People with one copy are usually carriers without symptoms.`;
  else if (moi === "AR" && two) plain = `You appear to have two copies of a variant linked to ${cond}. With two copies the condition can develop${lowPen ? ", although ClinVar notes low penetrance: many people with it never develop symptoms" : ""}.`;
  else if (moi === "AD" || moi === "SD") plain = `You appear to carry a variant where one copy can be enough to raise the chance of ${cond}${lowPen ? " (ClinVar notes low penetrance: many carriers never develop it)" : ""}.`;
  else plain = `You appear to carry a variant that ClinVar lists as disease-causing for ${cond}. What it means depends on how the condition is inherited.`;
  const why = [
    clinvarWhy(f, cond),
    moi ? `ClinGen: ${cond} (${f.match.site.gene}) is inherited as ${MOI_PLAIN[moi]}.` : "Inheritance pattern not established by ClinGen for this gene and condition.",
    `Your file shows ${f.zygosity} (${f.match.call?.raw ?? "?"}).`,
    "Consumer chips often misread rare variants, so this is a lead to check, not a result.",
  ];
  const next = ["Confirm with a clinical-grade genetic test before acting on this.", "Talk to a doctor or genetic counsellor."];
  if (moi === "AR" && !two) next.push("Mainly relevant for family planning: a child is affected only if both parents pass on a copy.");
  if (moi === "AD" || moi === "SD") next.push("Once confirmed, close relatives may want to know.");
  if (bulk) {
    why.unshift("Found by the genome-wide scan. Consumer chips misread very rare variants often: in one large study only 16% of very rare chip calls were confirmed by sequencing (Weedon et al., BMJ 2021).");
    next.push("If it matches a condition in you or your family, mention it to a doctor or genetic counsellor.");
  }
  return {
    id: `confirm-${r.id}`, tone: "confirm", category: "health", sufficient: r.stars >= 2, carried: true,
    evidenceLabel: `ClinVar ${r.stars}★${bulk ? " · chip call unverified" : ""}`,
    whyYou: `Your file shows ${f.zygosity === "homozygous" ? "two copies" : "one copy"} of a variant ClinVar lists as pathogenic.`,
    title: `${f.match.site.gene}: ${cond}`, plain, why, next,
    confidence: bulk || r.stars < 2 || f.match.site.kind !== "snv" ? "low" : "moderate",
    appendix: { section: "clinical" }, sources: [{ label: `ClinVar ${r.id}`, url: r.url }], sensitive: f.match.site.sensitive,
  };
}

const GENOTYPE_PLAIN = {
  "difference-reported": "Some studies found the effect differs by genotype, but the evidence is limited.",
  "tested-no-difference": "Studies found it works the same whatever your genotype, so your DNA result doesn't change this advice.",
  "not-established": "This is general advice. No study shows that your genotype changes how well it works.",
} as const;

export function actionItem(a: InterventionAssessment): SummaryItem {
  const iv = a.intervention;
  const strong = ["guideline", "meta-analysis", "systematic review"].includes(a.bestDesign);
  const why = [
    iv.triggerNote || `Shown because: ${a.triggeredBy.join("; ")}.`,
    `Best evidence behind it: ${a.bestDesign}.`,
    GENOTYPE_PLAIN[a.genotypeSpecific],
  ];
  const next = [...a.contextWarnings];
  if (iv.safety?.upperLimit) next.push(`Upper limit: ${iv.safety.upperLimit.value}.`);
  if (iv.type === "supplement") next.push("Check with a doctor or pharmacist before starting a supplement, especially if you take medication.");
  if (iv.type === "discuss with clinician") next.push("Bring this up at your next appointment. Don't change medication based on this report.");
  if (iv.type === "food" || iv.type === "lifestyle") next.push("Low-risk to try. Talk to a clinician if you have a related condition.");
  const sources = [...iv.generalEvidence, ...iv.genotypeEvidence].map((s) => ({ label: s.citation, url: s.ref.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${s.ref.pmid}/` : s.source.url }));
  const category: Category = iv.type === "supplement" ? "supplement" : iv.type === "lifestyle" ? "lifestyle" : iv.type === "discuss with clinician" ? "clinician" : "diet";
  const sufficient = STRONG_DESIGNS.includes(a.bestDesign) && (category !== "supplement" || !!iv.safety?.upperLimit);
  const DNA = { "difference-reported": "Maybe: limited evidence of a difference by genotype", "tested-no-difference": "No: works the same for everyone", "not-established": "Not shown: general advice" } as const;
  return {
    id: `action-${iv.id}`, tone: "action", category, sufficient, carried: true,
    evidenceLabel: cap(a.bestDesign), whyYou: iv.triggerNote.split(/(?<=\.)\s/)[0], dnaMatters: DNA[a.genotypeSpecific],
    caution: a.contextWarnings[0] ?? (iv.safety?.upperLimit ? `Upper limit: ${iv.safety.upperLimit.value}` : undefined),
    title: cap(iv.name), plain: iv.summary, why, next,
    confidence: strong ? "higher" : a.bestDesign === "randomized controlled trial" ? "moderate" : "low",
    appendix: { section: "actions" }, sources, sensitive: a.triggeredBy.some((t) => /alzheimer/i.test(t)),
  };
}

export function knowItem(f: GwasFinding, actionsFor: string[]): SummaryItem {
  const a = f.lead;
  const dir = f.direction === "increase" ? "higher" : "lower";
  const n = f.effectCopies ?? 0;
  const effect = a.orValue != null
    ? `linked to ${orAdverb(a.orValue)} ${dir} odds of ${f.topic.phrase}`
    : `linked to ${dir} ${f.topic.phrase}`;
  const freq = a.riskFrequency && Number(a.riskFrequency) > 0 && Number(a.riskFrequency) < 1 ? Math.round(Number(a.riskFrequency) * 100) : null;
  const plain = `You carry ${copies(n)} of a common ${f.match.site.gene} variant ${effect}. This is one small factor among many; it is not a diagnosis.`;
  const why = [
    `Lead study: ${a.orValue != null ? `odds ratio ${a.orValue} per copy` : `effect ${a.beta} per copy`}, ${a.initialSampleSize || "sample not reported"}.`,
    `${f.consistency.studies} publication(s) agree on the direction${f.consistency.discordant ? `; ${f.consistency.discordant} association(s) disagree` : ""}.`,
    ...(freq != null ? [`Common: this allele made up about ${freq}% of alleles in the study population.`] : []),
    "Odds ratios compare groups. They are not your personal chance of getting the condition.",
  ];
  const next = actionsFor.length ? actionsFor.map((x) => `See "${x}" under Things you could do.`) : ["No specific action is supported by evidence for this result."];
  if (f.topic.domain === "metabolism") next.push(f.topic.description);
  return {
    id: `know-${f.topic.id}-${a.rsid}`, tone: "know", category: "trait", sufficient: f.strength === "strong", carried: n > 0,
    evidenceLabel: `${f.consistency.studies} studies agree`, whyYou: `You carry ${copies(n)} of the ${f.match.site.gene} allele studied.`,
    title: f.topic.label, plain, why, next,
    confidence: f.strength === "strong" ? "higher" : "moderate",
    appendix: { section: f.topic.domain }, sources: [{ label: `${a.firstAuthor}, PMID ${a.pmid}`, url: a.paperUrl }], sensitive: f.match.site.sensitive,
  };
}

/** ClinVar "drug response" records the user carries, e.g. "methotrexate response - Toxicity". */
export function drugItem(f: ClinicalFinding): SummaryItem | null {
  const m = f.record.conditions.map((c) => c.match(/^(.+?) response - (.+)$/i)).find(Boolean);
  if (!m || !(f.altCopies ?? 0)) return null;
  const [, drug, effect] = m;
  return {
    id: `drug-${f.record.id}`, tone: "know", category: "medication", sufficient: f.record.stars >= 3, carried: true,
    evidenceLabel: `ClinVar ${f.record.stars}★${f.record.stars >= 3 ? " expert panel" : ""}`, whyYou: `Your genotype: ${f.match.call?.raw} (${f.zygosity}).`,
    title: `${cap(drug)}: medication response`,
    plain: `You carry a variant in ${f.match.site.gene} that ClinVar lists as affecting ${effect.toLowerCase()} of ${drug}.`,
    why: [`ClinVar: "${f.record.classification}" (${f.record.stars}/4 stars: ${f.record.reviewStatus}).`, `Your genotype: ${f.match.call?.raw} (${f.zygosity}).`],
    next: [`If you are ever prescribed ${drug}, mention this result to the prescriber. Don't change any medication yourself.`],
    confidence: f.record.stars >= 3 ? "higher" : "moderate", appendix: { section: f.match.site.domain === "clinical" ? "clinical" : f.match.site.domain },
    sources: [{ label: `ClinVar ${f.record.id}`, url: f.record.url }], sensitive: f.match.site.sensitive,
  };
}

// ─── Summary ────────────────────────────────────────────────────────────────

export function summarize(r: Report, opts: { showSensitive: boolean }): Summary {
  const items: SummaryItem[] = [];
  const visible = (i: SummaryItem) => opts.showSensitive || !i.sensitive;

  // Data quality first, if anything is off.
  // Only problems that undermine every result; minor ones (a few unreadable rows) stay in the appendix.
  const warns = r.file.issues.filter((i) => i.severity === "warning" && ["low-call-rate", "build"].includes(i.code));
  if (warns.length) {
    items.push({ id: "quality", tone: "quality", category: "quality", sufficient: true, carried: false, evidenceLabel: "File check", whyYou: "Applies to every result.", title: "Check your file first", plain: "Something about your file lowers confidence in every result below.",
      why: warns.map((w) => w.message), next: ["If possible, download a fresh copy of your raw data and upload it again."], confidence: "moderate", appendix: { section: "all" }, sources: [] });
  }

  // Confirm with a doctor.
  for (const f of r.clinical.filter((c) => c.category === "pathogenic-carried")) items.push(confirmItem(f));
  // Genome-wide scan hits: one item each (filterable), marked as unverified chip calls.
  for (const f of r.bulk?.clinvar.carried ?? []) items.push(confirmItem(f, true));

  // Things you could do.
  for (const a of r.interventions) items.push(actionItem(a));

  // Good to know.
  const all = [...r.disease, ...r.metabolism, ...r.performance];
  const actionTopics = new Map<string, string[]>();
  for (const a of r.interventions) for (const t of a.intervention.triggers) if ("topic" in t) actionTopics.set(t.topic, [...(actionTopics.get(t.topic) ?? []), cap(a.intervention.name)]);
  // Sites already raised under "Confirm with a doctor" are not repeated as common-variant notes.
  const confirmed = new Set(r.clinical.filter((c) => c.category === "pathogenic-carried").map((c) => c.record.rsid));
  for (const f of all) {
    if (f.kind === "gwas" && confirmed.has(f.match.site.rsid)) continue;
    if (f.kind === "gwas" && (f.effectCopies ?? 0) > 0 && (f.strength === "strong" || f.strength === "moderate")) items.push(knowItem(f, actionTopics.get(f.topic.id) ?? []));
    if (f.kind === "composite" && f.result !== "unknown") {
      items.push({ id: "know-apoe", tone: "know", category: "trait", sufficient: true, carried: true, evidenceLabel: "Derived from 2 SNPs", whyYou: "From your rs429358 and rs7412 genotypes.", title: "APOE type", plain: `Your APOE type appears to be ${f.result}. APOE is linked to Alzheimer disease and cholesterol; the Alzheimer and LDL rows in the appendix show what studies report.`,
        why: [f.headline, ...(f.ambiguity ? [f.ambiguity] : [])], next: ["Consider genetic counselling before acting on APOE results.", "No action is supported by evidence based on APOE type alone."],
        confidence: "moderate", appendix: { section: "disease" }, sources: [], sensitive: true });
    }
    if (f.kind === "clinical") { const d = drugItem(f); if (d) items.push(d); }
  }
  for (const f of r.clinical) { const d = drugItem(f); if (d && !items.some((i) => i.id === d.id)) items.push(d); }
  const notable = (r.bulk?.gwas.hits ?? []).filter((h) => h.domain === "disease" && (h.copies ?? 0) > 0 && h.strength === "strong" && h.kind === "OR" && (h.value >= 1.5 || h.value <= 1 / 1.5));
  const top = [...notable].sort((a, b) => Math.max(b.value, 1 / b.value) - Math.max(a.value, 1 / a.value)).slice(0, 25);
  for (const h of top) {
    const dir = h.value >= 1 ? "higher" : "lower";
    items.push({
      id: `scan-${h.rsid}-${h.traitUri}`, tone: "know", category: "trait", sufficient: true, carried: true,
      evidenceLabel: `${h.concordantPubs} studies agree`, whyYou: `You carry ${copies(h.copies ?? 0)} of the ${h.gene || h.rsid} allele studied.`,
      title: cap(h.trait),
      plain: `You carry ${copies(h.copies ?? 0)} of a variant near ${h.gene || "an unnamed gene"} linked to ${orAdverb(h.value)} ${dir} odds of ${h.trait}. It is a relative effect from population studies, not a diagnosis.`,
      why: [`Genome-wide scan: odds ratio ${h.value} per copy (p ${h.p}); ${h.concordantPubs} publications agree on the direction.`, `Lead study sample: ${h.sample || "not reported"}.`, "Odds ratios compare groups. They are not your personal chance of getting the condition."],
      next: ["No specific action is supported by evidence for this result.", "Open the technical details to read the studies."],
      confidence: "moderate", appendix: { section: "explorer", query: h.rsid }, sources: [{ label: `PMID ${h.leadPmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${h.leadPmid}/` }],
      sensitive: /alzheimer/i.test(h.trait),
    });
  }

  // Checked and not found.
  const clear = r.clinical.filter((c) => c.category === "not-carried" && /pathogenic/i.test(c.record.classification + c.record.rcvs.map((x) => x.classification).join(" ")));
  const untested = r.clinical.filter((c) => c.category === "not-tested");
  if (clear.length || untested.length || r.bulk) {
    const lines = [
      ...[...new Set(clear.map((c) => c.match.site.label))].map((l) => `Not found: ${l}`),
      ...[...new Set(untested.map((c) => c.match.site.label))].map((l) => `Not on your chip, so unknown: ${l}`),
    ];
    items.push({
      id: "clear", tone: "clear", category: "clear", sufficient: true, carried: false, evidenceLabel: "Tested", whyYou: "These were on your chip.", title: "Checked and not found",
      plain: `${clear.length ? "Several well-known disease variants were checked and not found in your file." : "Key variants were checked."}${r.bulk ? ` The genome-wide scan read ${r.bulk.clinvar.tested.toLocaleString()} known disease-causing variants and found ${r.bulk.clinvar.carried.length}.` : ""}`,
      why: ["Chips test only specific positions, so this can't rule out a condition. Other variants in the same genes are not tested."],
      next: ["If a condition runs in your family, ask about clinical testing regardless of this result."], confidence: "moderate",
      list: lines, appendix: { section: "clinical" }, sources: [],
    });
  }

  const shown = items.filter(visible);
  const n = (t: Tone) => shown.filter((i) => i.tone === t && i.sufficient).length;
  const headline = [
    n("confirm") ? `${n("confirm")} to confirm with a doctor` : "Nothing flagged to confirm with a doctor",
    `${n("action")} diet, supplement or lifestyle step${n("action") === 1 ? "" : "s"}`,
    `${n("know")} good to know`,
  ].join(" · ");
  return { headline, items: shown };
}

export function scanLine(h: BulkGwasHit): string {
  const dir = h.value >= 1 ? "higher" : "lower";
  return `${cap(h.trait)}: ${copies(h.copies ?? 0)} of ${h.gene || "a"} ${h.rsid} allele ${h.effectAllele}, ${orAdverb(h.value)} ${dir} odds (OR ${h.value}, ${h.concordantPubs} studies agree)`;
}

// Stage 3 — interpretation. Pure functions from (parsed genome, evidence
// bundle, optional user context) to a Report. No network, no randomness, no
// free text beyond fixed templates filled with verified values.
import { countAllele, isPalindromic, matchSite, orientAllele, zygosity } from "./match";
import type {
  ClinicalFinding, ClinVarRecord, CompositeFinding, EvidenceBundle, EvidenceStrength, Finding, GwasAssociation, GwasFinding,
  Intervention, InterventionAssessment, NoEvidenceFinding, ParsedGenome, Report, SiteMatch, TraitTopic, UserContext,
} from "./types";

export const EMPTY_CONTEXT: UserContext = { ageRange: "", ancestry: "", diagnoses: "", medications: "", allergies: "", dietaryRestrictions: "", goals: "" };

// ─── ClinVar ────────────────────────────────────────────────────────────────

const PATHOGENIC = /(^|[\s/;,])(likely )?pathogenic(?!ity)/i;
const VAGUE = /^(not provided|not specified|multiple conditions|see cases)$/i;

/**
 * Category from ClinVar, in priority order:
 * 1. aggregate conflicting → conflicting;
 * 2. aggregate P/LP, or any per-condition (RCV) P/LP with ≥2 review stars → pathogenic;
 * 3. per-condition conflicting (≥1 star) → conflicting; 4. risk factor; 5. VUS; 6. other annotation.
 */
export function classifyClinVar(r: ClinVarRecord): { kind: "pathogenic" | "risk-factor" | "conflicting" | "uncertain" | "annotation"; conditions: string[] } {
  const c = r.classification.toLowerCase();
  const named = (xs: typeof r.rcvs) => [...new Set(xs.map((x) => x.condition).filter((n) => !VAGUE.test(n)))];
  if (r.conflicting) return { kind: "conflicting", conditions: r.conditions };
  const pRcv = r.rcvs.filter((x) => PATHOGENIC.test(x.classification) && !/conflicting/i.test(x.classification) && x.stars >= 2);
  if (PATHOGENIC.test(c) || pRcv.length) return { kind: "pathogenic", conditions: named(pRcv).length ? named(pRcv) : r.conditions };
  const cRcv = r.rcvs.filter((x) => /conflicting/i.test(x.classification) && x.stars >= 1);
  if (cRcv.length) return { kind: "conflicting", conditions: named(cRcv) };
  if (c.includes("risk factor")) return { kind: "risk-factor", conditions: r.conditions };
  if (c.includes("uncertain significance")) return { kind: "uncertain", conditions: r.conditions };
  return { kind: "annotation", conditions: r.conditions };
}

export function clinicalFinding(m: SiteMatch, r: ClinVarRecord, bundle: EvidenceBundle): ClinicalFinding {
  // Clinical calls use the forward strand only: a strand-flipped reading is never counted.
  const copies = m.orientation === "complemented" ? null : countAllele(m, r.altAllele);
  const zyg = zygosity(m, copies);
  const clingen = bundle.clingen.filter((g) => g.gene === m.site.gene);
  const { kind, conditions } = classifyClinVar(r);
  const condText = conditions.slice(0, 4).join("; ") + (conditions.length > 4 ? "; …" : "");
  const limitations: string[] = [
    "Consumer genotyping arrays can mis-call rare variants. A clinical-grade test is needed before any decision.",
  ];
  if (r.stars <= 1) limitations.push(`ClinVar review status is "${r.reviewStatus}" (${r.stars}/4 stars): limited review.`);
  if (m.orientation === "complemented") limitations.push("Your file's alleles only fit this record after flipping strands. Consumer files use the forward strand, so this is treated as not tested rather than risk a false alarm.");

  let category: ClinicalFinding["category"];
  let headline: string;
  const allele = `${r.altAllele} (${r.title})`;
  if (copies == null) {
    category = "not-tested";
    headline = m.status === "not-on-array" ? "Not tested in your file. This is not a negative result." : `Not interpretable (${m.status}).`;
  } else if (copies === 0) {
    category = kind === "conflicting" ? "conflicting" : "not-carried";
    headline = `Tested: the ClinVar allele ${r.altAllele} was not observed. This does not rule out other variants in ${m.site.gene}.`;
  } else if (kind === "pathogenic") {
    category = "pathogenic-carried";
    const ar = clingen.filter((g) => g.moi === "AR").map((g) => g.disease);
    headline = `${zyg[0].toUpperCase() + zyg.slice(1)} for ${allele}, classified pathogenic in ClinVar for ${condText || "the listed conditions"}. Needs confirmation by clinical testing.`;
    if (zyg === "heterozygous" && ar.length) {
      headline += ` ClinGen curates ${ar.join("; ")} as autosomal recessive; one copy usually indicates carrier status.`;
    }
  } else if (kind === "risk-factor") {
    category = "risk-factor-carried";
    headline = `${zyg[0].toUpperCase() + zyg.slice(1)} for ${allele}. ClinVar: "${r.classification}". A risk factor is not a diagnosis.`;
  } else if (kind === "conflicting") {
    category = "conflicting";
    headline = `${zyg[0].toUpperCase() + zyg.slice(1)} for ${allele}. ClinVar submitters disagree${condText ? ` (${condText})` : ""}. Not actionable without expert review.`;
  } else if (kind === "uncertain") {
    category = "uncertain";
    headline = `${zyg[0].toUpperCase() + zyg.slice(1)} for ${allele}. Variant of uncertain significance: not actionable.`;
  } else {
    category = "annotation";
    headline = `${zyg[0].toUpperCase() + zyg.slice(1)} for ${allele}. ClinVar: "${r.classification}".`;
  }
  return { kind: "clinical", match: m, record: r, clingen, altCopies: copies, zygosity: zyg, category, headline, limitations };
}

// ─── GWAS ───────────────────────────────────────────────────────────────────

function sign(a: GwasAssociation): 1 | -1 | 0 {
  if (a.orValue != null) return a.orValue > 1 ? 1 : a.orValue < 1 ? -1 : 0;
  if (a.beta) return /decrease/i.test(a.beta) ? -1 : /increase/i.test(a.beta) ? 1 : 0;
  return 0;
}

export function gwasFinding(topic: TraitTopic, m: SiteMatch, assocs: GwasAssociation[]): GwasFinding {
  const site = m.site;
  // Express every association's direction relative to the main alternate allele.
  const directed = assocs.map((a) => {
    const o = orientAllele(a.effectAllele, site).allele;
    const s = sign(a);
    const d = !o || s === 0 ? 0 : o === site.mainAlt ? s : o === site.ref ? -s : 0;
    return { a, d };
  });
  const up = directed.filter((x) => x.d === 1).length, down = directed.filter((x) => x.d === -1).length;
  const majority = up === 0 && down === 0 ? 0 : up >= down ? 1 : -1;
  const concordantSet = directed.filter((x) => majority !== 0 && x.d === majority);
  const discordant = directed.filter((x) => majority !== 0 && x.d === -majority).length;
  const concordant = concordantSet.length;
  const papers = new Set(concordantSet.map((x) => x.a.pmid)).size;

  // Lead: from the majority cluster; prefer study metadata, an OR, and an effect allele equal to the main alt.
  const pool = concordantSet.length ? concordantSet.map((x) => x.a) : assocs;
  const score = (a: GwasAssociation) => (a.initialSampleSize ? 4 : 0) + (a.orValue != null ? 2 : 0) + (orientAllele(a.effectAllele, site).allele === site.mainAlt ? 1 : 0);
  const lead = [...pool].sort((x, y) => score(y) - score(x))[0]; // stable: keeps catalog p-value order within ties
  const leadOriented = orientAllele(lead.effectAllele, site);
  const leadSign = sign(lead);
  const strength: EvidenceStrength =
    discordant > 0 && discordant >= Math.max(1, concordant * 0.25) ? "conflicting" : papers >= 3 ? "strong" : papers === 2 ? "moderate" : papers === 1 ? "limited" : "insufficient";

  const ambiguous = leadOriented.how === "ambiguous" || isPalindromic(site);
  const effectCopies = ambiguous || !leadOriented.allele ? null : countAllele(m, leadOriented.allele);
  const direction = leadSign === 1 ? "increase" : leadSign === -1 ? "decrease" : "unclear";
  const effect = lead.orValue != null ? `odds ratio ${lead.orValue}${lead.ci ? ` ${lead.ci}` : ""} per copy` : lead.beta ? `effect ${lead.beta} per copy (units as reported)` : "effect size not reported";

  const limitations = [
    "Population association: it describes average differences between groups, not a diagnosis or your personal risk.",
    "No absolute risk is shown because the report has no validated baseline risk for you.",
  ];
  if (ambiguous) limitations.push(`Palindromic (strand-ambiguous) site: the study's effect allele ${lead.effectAllele} cannot be reliably aligned to your genotype, so allele copies are not counted.`);
  if (leadOriented.how === "complemented") limitations.push(`The catalog reported the effect allele on the opposite strand (${lead.effectAllele}); aligned to ${leadOriented.allele}.`);
  if (leadOriented.how === "unresolvable") limitations.push(`The reported effect allele "${lead.effectAllele}" does not match this site's alleles; not counted.`);
  if (lead.ancestry.length) limitations.push(`Lead study population: ${lead.ancestry.join("; ")}. Effects may differ in other ancestries.`);
  if (strength === "conflicting") limitations.push(`${discordant} association(s) point in the opposite direction.`);

  let headline: string;
  if (m.status !== "matched") headline = m.status === "not-on-array" ? "Not tested in your file. No conclusion either way." : `Genotype not usable (${m.status}).`;
  else if (effectCopies == null) headline = `Your genotype ${m.forwardAlleles.join("")}. Allele copies not counted (see limitations).`;
  else if (strength === "conflicting") headline = `${effectCopies} cop${effectCopies === 1 ? "y" : "ies"} of ${leadOriented.allele}. Studies disagree on the direction of effect for ${topic.phrase}, so no direction is stated.`;
  else headline = `${effectCopies} cop${effectCopies === 1 ? "y" : "ies"} of ${leadOriented.allele}, the allele associated with ${direction === "unclear" ? "a difference in" : direction === "increase" ? "higher" : "lower"}${lead.orValue != null ? " odds of" : ""} ${topic.phrase} (${effect}, lead study).`;

  return {
    kind: "gwas", topic, match: m, lead, supporting: assocs.filter((a) => a !== lead), effectAlleleForward: leadOriented.allele,
    effectCopies, direction, consistency: { concordant, discordant, studies: papers }, strength, headline, limitations,
  };
}

// ─── Composite: APOE ────────────────────────────────────────────────────────

/** APOE ε2/ε3/ε4 from rs429358 (T>C) and rs7412 (C>T), forward strand. */
export function apoeFinding(topic: TraitTopic, m429: SiteMatch, m7412: SiteMatch): CompositeFinding {
  const base = { kind: "composite" as const, id: "apoe", topic, matches: [m429, m7412], limitations: [
    "Consumer arrays genotype these two SNPs; the ε-type is inferred from both, and the two SNPs are not phased.",
    "APOE findings can be distressing and are not a diagnosis. Consider genetic counselling before acting on them.",
  ] };
  const expected = m429.site.ref === "T" && m429.site.alts.includes("C") && m7412.site.ref === "C" && m7412.site.alts.includes("T");
  if (!expected) return { ...base, result: "unknown", ambiguity: null, headline: "APOE type could not be derived: reference alleles differ from the expected definition." };
  if (m429.status !== "matched" || m7412.status !== "matched") {
    return { ...base, result: "unknown", ambiguity: null, headline: "APOE type not determined: one or both defining SNPs were not tested or not readable." };
  }
  const c = countAllele(m429, "C")!;
  const t = countAllele(m7412, "T")!;
  const table: Record<string, [string, string | null]> = {
    "0,0": ["ε3/ε3", null], "1,0": ["ε3/ε4", null], "2,0": ["ε4/ε4", null], "0,1": ["ε2/ε3", null], "0,2": ["ε2/ε2", null],
    "1,1": ["ε2/ε4", "Unphased: this genotype is usually ε2/ε4 but could be the rare ε1/ε3."],
  };
  const [result, ambiguity] = table[`${c},${t}`] ?? ["unusual combination", "This combination implies the rare ε1 allele or a genotyping error."];
  return { ...base, result, ambiguity, headline: `APOE type ${result}. See the Alzheimer disease and LDL association rows for what studies report.` };
}

// ─── Interventions ──────────────────────────────────────────────────────────

const STRONG_DESIGNS = ["meta-analysis", "systematic review", "guideline"];

export function assessIntervention(iv: Intervention, findings: Finding[], clinical: ClinicalFinding[], ctx: UserContext): InterventionAssessment | null {
  const reasons: string[] = [];
  for (const t of iv.triggers) {
    if ("topic" in t) {
      const fs = findings.filter((f): f is Exclude<Finding, ClinicalFinding> => f.kind !== "clinical" && f.topic.id === t.topic);
      if (t.when === "effect-allele-carried" && fs.some((f) => f.kind === "gwas" && (f.effectCopies ?? 0) > 0)) reasons.push(`Carries an allele associated with ${fs[0].topic.phrase}`);
      if (t.when === "tested" && fs.some((f) => (f.kind === "gwas" ? [f.match] : f.matches).some((m) => m.status === "matched"))) reasons.push(`${fs[0].topic.label} variants tested`);
    } else if ("clinvarAll" in t) {
      const ok = t.clinvarAll.every((rs) => clinical.some((c) => c.record.rsid === rs && (c.altCopies ?? 0) > 0));
      if (ok) reasons.push(`ClinVar alleles observed at ${t.clinvarAll.map((rs) => clinical.find((c) => c.record.rsid === rs)!.match.site.label).join(" and ")}`);
    } else {
      const cs = clinical.filter((c) => c.record.rsid === t.clinvar);
      if (t.when === "alt-homozygous" && cs.some((c) => c.altCopies === 2)) reasons.push(`Two copies of the ClinVar allele at ${cs[0].match.site.label}`);
      if (t.when === "pathogenic-carried" && cs.some((c) => c.category === "pathogenic-carried")) reasons.push(`ClinVar pathogenic allele observed at ${cs[0].match.site.label}`);
      if (t.when === "alt-carried" && cs.some((c) => (c.altCopies ?? 0) > 0)) reasons.push(`ClinVar allele observed at ${cs[0].match.site.label}`);
      if (t.when === "alt-not-carried" && cs.length && cs.every((c) => c.altCopies === 0)) reasons.push(`ClinVar allele not observed at ${cs[0].match.site.label}`);
    }
  }
  if (!reasons.length) return null;

  const all = [...iv.generalEvidence, ...iv.genotypeEvidence].filter((s) => s.humans);
  const generalSupport: EvidenceStrength = all.some((s) => STRONG_DESIGNS.includes(s.design)) ? "strong"
    : all.some((s) => s.design === "randomized controlled trial") ? "moderate" : all.length ? "limited" : "insufficient";
  const ORDER = ["guideline", "meta-analysis", "systematic review", "randomized controlled trial", "observational", "review", "other"];
  const bestDesign = all.map((s) => s.design).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] ?? "none verified";
  const g = iv.genotypeEvidence;
  const genotypeSpecific = g.some((s) => s.genotypeInteraction === "tested-difference") ? "difference-reported"
    : g.some((s) => s.genotypeInteraction === "tested-no-difference") ? "tested-no-difference" : "not-established";

  const contextWarnings = iv.contextFlags
    .filter((f) => { const v = ctx[f.field].toLowerCase(); return v && f.matchAny.some((k) => v.includes(k.toLowerCase())); })
    .map((f) => (f.evidence ? `${f.message} Source: ${f.evidence.citation}, "${f.evidence.quote}"` : f.message));
  return { intervention: iv, triggeredBy: reasons, generalSupport, genotypeSpecific, bestDesign, contextWarnings };
}

// ─── Context ────────────────────────────────────────────────────────────────

const ANCESTRY_WORDS: [RegExp, RegExp][] = [
  [/europe|white|caucasian|british|irish|german|italian|scandinav/i, /europe|british|finnish|icelandic|white/i],
  [/africa|black/i, /africa|afro/i],
  [/east asian|chinese|japanese|korean|taiwan/i, /east asian|chinese|japanese|korean|taiwan/i],
  [/south asian|indian|pakistan|bangladesh|sri lank/i, /south asian|indian|pakistan|bangladesh/i],
  [/hispanic|latin|mexican/i, /hispanic|latin|mexican/i],
];

export function ancestryMismatch(userAncestry: string, studyAncestry: string[]): boolean {
  if (!userAncestry.trim() || !studyAncestry.length) return false;
  const joined = studyAncestry.join(" ");
  const groups = ANCESTRY_WORDS.filter(([u]) => u.test(userAncestry));
  return groups.length > 0 && !groups.some(([, s]) => s.test(joined));
}

export function contextNotes(ctx: UserContext): string[] {
  const n: string[] = [];
  if (!Object.values(ctx).some((v) => v.trim())) {
    n.push("No personal context entered. Findings are shown from genotype alone, and no clinical advice is derived from them.");
    return n;
  }
  if (ctx.ancestry) n.push("Ancestry: association rows whose lead study population differs from your stated ancestry are flagged, because effect sizes may not transfer.");
  if (ctx.ageRange) n.push("Age: used only to flag age-dependent safety limits (e.g. supplement upper limits).");
  if (ctx.diagnoses) n.push("Diagnoses: a clinical diagnosis and your clinician's plan always take precedence over genotype. Matching items are flagged.");
  if (ctx.medications) n.push("Medications: used only to flag possible interactions for discussion. Never stop or change medication based on this report.");
  if (ctx.allergies || ctx.dietaryRestrictions) n.push("Allergies and diet: food-based options that conflict are flagged.");
  if (ctx.goals) n.push("Goals: used only to order sections; they do not change any finding.");
  return n;
}

// ─── Report ─────────────────────────────────────────────────────────────────

export function buildReport(genome: ParsedGenome, bundle: EvidenceBundle, ctx: UserContext = EMPTY_CONTEXT): Report {
  const matches = bundle.sites.map((s) => matchSite(genome, s));
  const bySite = new Map(matches.map((m) => [m.site.rsid, m]));

  const clinicalAll = bundle.clinvar.filter((r) => bySite.has(r.rsid)).map((r) => clinicalFinding(bySite.get(r.rsid)!, r, bundle));
  const topicFindings: Finding[] = [];
  for (const topic of bundle.traits) {
    const tms = topic.rsids.map((r) => bySite.get(r)).filter((m): m is SiteMatch => !!m);
    let any = false;
    for (const m of tms) {
      const assocs = bundle.gwas.filter((a) => a.rsid === m.site.rsid && a.traitLabel === topic.label);
      if (!assocs.length) continue;
      const f = gwasFinding(topic, m, assocs);
      if (ctx.ancestry && ancestryMismatch(ctx.ancestry, f.lead.ancestry)) f.limitations.push(`Your stated ancestry ("${ctx.ancestry}") is not represented in the lead study population.`);
      topicFindings.push(f);
      any = true;
    }
    // APOE: topic.rsids are [rs429358, rs7412] (ε4-defining, ε2-defining).
    if (topic.id === "alzheimers" && tms.length === 2) topicFindings.push(apoeFinding(topic, tms[0], tms[1]));
    if (!any) {
      const tested = tms.some((m) => m.status === "matched");
      const hasClinVar = bundle.clinvar.some((r) => topic.rsids.includes(r.rsid));
      const ne: NoEvidenceFinding = {
        kind: "no-evidence", topic, matches: tms,
        headline: tested
          ? `Tested, but no genome-wide significant association (p < 5×10⁻⁸) for this trait was found in the GWAS Catalog for these variants.${hasClinVar ? " See the ClinVar record for this site in this section." : ""}`
          : "None of these variants were tested in your file. No conclusion either way.",
        limitations: ["Absence of catalogued evidence is not evidence of no effect."],
      };
      topicFindings.push(ne);
    }
  }

  const clinicalSection = clinicalAll.filter((f) => f.match.site.domain === "clinical" || f.category === "pathogenic-carried");
  const annotations = clinicalAll.filter((f) => !clinicalSection.includes(f));
  const domainOf = (f: Finding) => (f.kind === "clinical" ? f.match.site.domain : f.topic.domain);
  const pick = (d: string) => [...topicFindings, ...annotations].filter((f) => domainOf(f) === d);

  const interventions = bundle.interventions
    .map((iv) => assessIntervention(iv, topicFindings, clinicalAll, ctx))
    .filter((a): a is InterventionAssessment => !!a);
  const triggeredTopics = new Set(interventions.flatMap((a) => a.intervention.triggers.flatMap((t) => ("topic" in t ? [t.topic] : "clinvarAll" in t ? t.clinvarAll : [t.clinvar]))));
  const topicsWithoutAction = bundle.traits
    .filter((t) => !t.rsids.some((r) => triggeredTopics.has(r)) && !triggeredTopics.has(t.id))
    .filter((t) => t.rsids.some((r) => bySite.get(r)?.status === "matched"))
    .map((t) => t.label);

  const count = (s: string) => matches.filter((m) => m.status === s).length;
  return {
    generatedAt: new Date().toISOString(),
    file: { format: genome.format, build: genome.build, stats: genome.stats, issues: genome.issues },
    coverage: { total: matches.length, matched: count("matched"), notOnArray: count("not-on-array"), noCall: count("no-call"), mismatch: count("allele-mismatch") },
    matches,
    clinical: clinicalSection,
    disease: pick("disease"), metabolism: pick("metabolism"), performance: pick("performance"),
    interventions, topicsWithoutAction, contextNotes: contextNotes(ctx), evidenceSources: bundle.sources,
  };
}

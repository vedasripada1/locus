// One search box over everything in the report: summary items, curated sites and topics,
// actions, the genome-wide ClinVar screen (including "was this gene even tested?"), and
// GWAS associations. Results are plain-language lines with a pointer to the details.
import type { Report } from "./types";
import type { BulkGwasHit } from "./bulk";
import { orAdverb, scanLine, type Summary } from "./plain";

export type SearchGroup = "Your summary" | "Traits & genes" | "Curated results" | "Actions" | "Rare disease variants" | "Trait associations";

export interface SearchHit {
  group: SearchGroup;
  title: string;
  plain: string;
  /** Where to go for detail. */
  target: { tab: "summary"; id: string } | { tab: "appendix"; section: string; query?: string };
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Score how well `text` matches `q` (0 = no match). */
export function matchScore(q: string, text: string): number {
  const nq = norm(q), nt = norm(text);
  if (!nq || !nt) return 0;
  if (nt === nq) return 100;
  if (nt.startsWith(nq)) return 80;
  if (new RegExp(`\\b${nq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(nt)) return 60;
  if (nt.includes(nq)) return 40;
  const words = nq.split(" ");
  return words.length > 1 && words.every((w) => nt.includes(w)) ? 30 : 0;
}

const best = (q: string, ...texts: (string | undefined)[]) => Math.max(0, ...texts.map((t) => (t ? matchScore(q, t) : 0)));

export function searchReport(r: Report, summary: Summary, q: string, opts: { showSensitive: boolean }): SearchHit[] {
  const query = q.trim();
  if (query.length < 2) return [];
  if (!opts.showSensitive && /alzheimer|apoe/i.test(query)) return [];
  const hits: SearchHit[] = [];
  const hidden = (text: string) => !opts.showSensitive && /alzheimer|apoe/i.test(text);

  // Summary items (already plain language).
  for (const i of summary.items) {
    const s = best(query, i.title, i.plain, ...(i.list ?? []), ...i.why);
    if (s) hits.push({ group: "Your summary", title: i.title, plain: i.plain, target: { tab: "summary", id: i.id }, score: s + 10 });
  }

  // Gene guide: one hit per gene, with your reading.
  for (const g of r.genes ?? []) {
    if (!opts.showSensitive && g.entry.sensitive) continue;
    const s = best(query, g.entry.title, g.entry.gene, g.entry.what, ...g.entry.sites.map((x) => x.rsid));
    if (!s) continue;
    const reading = g.status === "not-tested" ? "Not on your chip, so not tested." : g.reading?.text ?? "Only partly readable from your file.";
    hits.push({ group: "Traits & genes", title: `${g.entry.title} (${g.entry.gene})`, plain: reading, target: { tab: "summary", id: `gene-${g.entry.id}` }, score: s + 5 });
  }

  // Curated sites: status of every curated variant, carried or not.
  for (const m of r.matches) {
    if (!opts.showSensitive && m.site.sensitive) continue;
    const s = best(query, m.site.rsid, m.site.gene, m.site.label);
    if (!s) continue;
    const status = m.status === "matched" ? `Your genotype: ${m.call!.raw}.` : m.status === "not-on-array" ? "Not on your chip, so not tested." : m.status === "no-call" ? "On your chip but unreadable." : "Genotype could not be interpreted.";
    hits.push({ group: "Curated results", title: `${m.site.label} (${m.site.rsid})`, plain: `${status} See the ${m.site.domain} section for what it means.`, target: { tab: "appendix", section: m.site.domain === "clinical" ? "clinical" : m.site.domain }, score: s });
  }
  for (const t of r.disease.concat(r.metabolism, r.performance)) {
    if (t.kind === "clinical") continue;
    if (hidden(t.topic.label)) continue;
    const s = best(query, t.topic.label, t.topic.phrase);
    const label = t.kind === "gwas" ? `${t.topic.label}: ${t.match.site.label}` : t.topic.label;
    if (s) hits.push({ group: "Curated results", title: label, plain: t.headline, target: { tab: "appendix", section: t.topic.domain }, score: s });
  }

  // Actions.
  for (const a of r.interventions) {
    const iv = a.intervention;
    const s = best(query, iv.name, iv.summary, ...a.triggeredBy);
    if (s && !hidden(a.triggeredBy.join(" ")) && !hits.some((h) => h.target.tab === "summary" && h.target.id === `action-${iv.id}`)) hits.push({ group: "Actions", title: iv.name, plain: iv.summary, target: { tab: "summary", id: `action-${iv.id}` }, score: s });
  }

  // Genome-wide ClinVar screen: flagged variants, plus coverage by gene and condition.
  const cv = r.bulk?.clinvar;
  if (cv) {
    for (const f of cv.carried) {
      const s = best(query, f.match.site.gene, f.record.rsid, f.record.title, ...f.record.conditions);
      if (s) hits.push({ group: "Rare disease variants", title: `${f.match.site.gene}: ${f.record.conditions[0] ?? f.record.title}`, plain: `Flagged: your chip reported ${f.zygosity === "homozygous" ? "two copies" : "one copy"} of a variant ClinVar lists as ${f.record.classification.toLowerCase()} (${f.record.stars}★). Needs a clinical test to confirm; most chip calls like this are errors.`, target: { tab: "appendix", section: "clinical" }, score: s + 5 });
    }
    for (const [gene, [tested, carried]] of Object.entries(cv.byGene)) {
      const s = best(query, gene);
      if (s >= 60) hits.push({ group: "Rare disease variants", title: `${gene}: coverage`, plain: `${tested} known disease-causing ${gene} variant${tested === 1 ? " was" : "s were"} readable on your chip; ${carried ? `${carried} flagged` : "none flagged"}. Chips test only a small fraction of possible variants, so this does not rule anything out.`, target: { tab: "appendix", section: "clinical" }, score: s });
    }
    const conds = Object.entries(cv.byCondition).map(([c, v]) => ({ c, v, s: best(query, c) })).filter((x) => x.s >= 40).sort((a, b) => b.s - a.s).slice(0, 5);
    for (const { c, v: [tested, carried], s } of conds) hits.push({ group: "Rare disease variants", title: `${c}: coverage`, plain: `${tested} known disease-causing variant${tested === 1 ? "" : "s"} for this condition were readable on your chip; ${carried ? `${carried} flagged` : "none flagged"}. This does not rule the condition in or out.`, target: { tab: "appendix", section: "clinical" }, score: s });
    const geneKnown = Object.keys(cv.byGene).some((g) => matchScore(query, g) >= 80);
    if (!geneKnown && /^[A-Z0-9-]{2,10}$/.test(query)) {
      hits.push({ group: "Rare disease variants", title: `${query.toUpperCase()}: coverage`, plain: `No known disease-causing ${query.toUpperCase()} variants from ClinVar were readable on your chip (or the gene has none with an rsID). This is not a negative result.`, target: { tab: "appendix", section: "clinical" }, score: 20 });
    }
  }

  // GWAS associations: group by trait when the query names a trait.
  const gw = r.bulk?.gwas.hits ?? [];
  const byTrait = new Map<string, BulkGwasHit[]>();
  for (const h of gw) {
    if (hidden(h.trait)) continue;
    const s = best(query, h.trait);
    if (s >= 40) (byTrait.get(h.trait) ?? byTrait.set(h.trait, []).get(h.trait)!).push(h);
    else {
      const sv = best(query, h.rsid, h.gene);
      if (sv >= 60) hits.push({ group: "Trait associations", title: `${h.trait} · ${h.gene || h.rsid}`, plain: gwasPlain(h), target: { tab: "appendix", section: "explorer", query: h.rsid }, score: sv - 5 });
    }
  }
  for (const [trait, hs] of byTrait) {
    const carried = hs.filter((h) => (h.copies ?? 0) > 0);
    const replicated = carried.filter((h) => h.strength === "strong" || h.strength === "moderate");
    const top = [...replicated].sort((a, b) => b.concordantPubs - a.concordantPubs).slice(0, 3);
    hits.push({
      group: "Trait associations", title: trait,
      plain: `${hs.length} variant${hs.length === 1 ? "" : "s"} in your file ${hs.length === 1 ? "is" : "are"} linked to ${trait} in the GWAS Catalog; you carry the reported allele at ${carried.length} (${replicated.length} replicated). Each has a small, relative effect.${top.length ? ` Most replicated: ${top.map(scanLine).join("; ")}.` : ""}`,
      target: { tab: "appendix", section: "explorer", query: trait }, score: best(query, trait),
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, 60);
}

export function gwasPlain(h: BulkGwasHit): string {
  const n = h.copies;
  const carry = n == null ? "Allele copies can't be counted at this site (strand-ambiguous)." : `You carry ${n} cop${n === 1 ? "y" : "ies"} of the reported allele ${h.effectForward ?? h.effectAllele}.`;
  const eff = h.kind === "OR" ? `${orAdverb(h.value)} ${h.value >= 1 ? "higher" : "lower"} odds (OR ${h.value})` : `a ${h.direction === "increase" ? "higher" : h.direction === "decrease" ? "lower" : "different"} average level (β ${h.value})`;
  return `${carry} Studies link it to ${eff}; evidence ${h.strength} (${h.concordantPubs} stud${h.concordantPubs === 1 ? "y" : "ies"} agree).`;
}

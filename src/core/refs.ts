// Reference text (verbatim) from GeneReviews and MedlinePlus, loaded with the bulk data.
export interface Chapter { pmid: string; nbk: string; title: string; clinical: string; management: string; counseling: string; url: string }
export interface Topic { title: string; url: string; summary: string; lifestyle: string[] }
export interface References {
  retrievedAt: string;
  genereviews: { chapters: Chapter[]; genes: Record<string, number[]> };
  medlineplus: { families: { id: string; pattern: string; topics: string[] }[]; topics: Record<string, Topic> };
}

export const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((x) => x.trim()).filter(Boolean);
export const firstSentences = (t: string, n: number) => sentencesOf(t).slice(0, n).join(" ");

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["disease", "syndrome", "type", "related", "associated", "hereditary"].includes(w)));

/** The GeneReviews chapter for a gene that best matches the finding's conditions (by shared words). */
export function chapterFor(refs: References | null | undefined, gene: string, conditions: string[]): Chapter | null {
  const idx = refs?.genereviews.genes[gene];
  if (!idx?.length) return null;
  const want = words(conditions.join(" "));
  const scored = idx.map((i) => refs!.genereviews.chapters[i]).map((c) => ({ c, s: [...words(c.title)].filter((w) => want.has(w)).length }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0].c;
}

/** GeneReviews management text split at its sub-headings ("Surveillance:", "Agents/circumstances to avoid:" …). */
export function managementParts(m: string): string[] {
  return m.split(/\s(?=(?:Treatment of manifestations|Prevention of primary manifestations|Prevention of secondary complications|Surveillance|Agents\/circumstances to avoid|Evaluation of relatives at risk|Pregnancy management|Targeted therapies?|Supportive care|Therapies under investigation|Risk-reducing surgery|Other)(?: \([^)]*\))?:)/).map((x) => x.trim()).filter(Boolean);
}

/** MedlinePlus topics for a GWAS trait label. */
export function topicsFor(refs: References | null | undefined, trait: string): string[] {
  if (!refs) return [];
  const fam = refs.medlineplus.families.find((f) => new RegExp(f.pattern, "i").test(trait));
  return fam?.topics ?? [];
}

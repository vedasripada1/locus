// Supplements & your DNA: for each supplement, combine the file's gene guide results into one verdict.
// The verdict only reuses gene guide verdicts and readings (verified in pipeline/genes.ts); nothing new
// is claimed here. Text comes from fixed templates.
import type { EvidenceBundle, GeneResult, Report, SupplementEntry, SupplementResult, SupplementVerdict } from "./types";

/**
 * Priority order:
 *  1. dna-changes — a linked gene whose verdict says genotype changes the advice (or has limited
 *     genotype-specific evidence), and your reading at it is flagged notable;
 *  2. test-first — a linked gene was read and its verdict says a blood test answers this better;
 *  3. same — linked genes were read and none changes the advice for you;
 *  4. not-read — the supplement has linked genes but none could be read from the file;
 *  5. no-genes — no well-studied gene in the guide bears on this supplement.
 */
export function supplementResult(entry: SupplementEntry, genes: GeneResult[], report: Pick<Report, "interventions">, showSensitive = false): SupplementResult {
  // Sensitive genes (e.g. APOE) stay hidden until the person chooses to see them, here as everywhere else.
  const linked = entry.genes.map((id) => genes.find((g) => g.entry.id === id)).filter((g): g is GeneResult => !!g && (showSensitive || !g.entry.sensitive));
  const read = linked.filter((g) => g.status !== "not-tested" && g.reading);
  const changes = read.find((g) => ["changes-advice", "limited"].includes(g.entry.verdict) && g.reading?.tone === "notable");
  const test = read.find((g) => g.entry.verdict === "test-instead");
  let verdict: SupplementVerdict, decidedBy: GeneResult | null = null;
  if (changes) { verdict = "dna-changes"; decidedBy = changes; }
  else if (test) { verdict = "test-first"; decidedBy = test; }
  else if (read.length) verdict = "same";
  else verdict = linked.length ? "not-read" : "no-genes";
  const actions = report.interventions.filter((a) => entry.interventions.includes(a.intervention.id));
  return { entry, verdict, decidedBy, genes: linked, actions };
}

export function supplementResults(bundle: EvidenceBundle, report: Report, showSensitive = false): SupplementResult[] {
  return (bundle.supplements?.entries ?? []).map((e) => supplementResult(e, report.genes ?? [], report, showSensitive));
}

/** One plain sentence per verdict. */
export function verdictLine(r: SupplementResult): string {
  const g = r.decidedBy?.entry.title;
  switch (r.verdict) {
    case "dna-changes": return `Your DNA may change the advice here: see ${g}.`;
    case "test-first": return `A blood test tells you more than your DNA here: see ${g}.`;
    case "same": return "Nothing in your DNA changes the advice for this supplement.";
    case "not-read": return "The genes that matter here weren't on your chip, so your DNA can't say anything either way.";
    case "no-genes": return "No well-studied gene changes the advice for this supplement, so the advice is the same for everyone.";
  }
}

export const VERDICT_LABEL: Record<SupplementVerdict, { label: string; chip: string; order: number }> = {
  "dna-changes": { label: "Your DNA may change the advice", chip: "conf-higher", order: 0 },
  "test-first": { label: "A blood test answers this better", chip: "conf-moderate", order: 1 },
  same: { label: "Same advice for you", chip: "conf-low", order: 2 },
  "not-read": { label: "Not on your chip", chip: "conf-low", order: 3 },
  "no-genes": { label: "Same advice for everyone", chip: "conf-low", order: 4 },
};

/** Plain summary of the literature map for one gene, e.g. "VDR: 3,231 papers, 113 trials, 312 reviews". */
export function mapLine(m: SupplementEntry["map"][number]): string {
  const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
  return `${m.gene}: ${n(m.total, "paper")}, ${n(m.trials, "trial")}, ${n(m.reviews, "review")}`;
}

/** Search by name, alias or gene. */
export function matchesSupplement(r: SupplementResult, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const e = r.entry;
  return [e.name, ...e.aliases, ...e.map.map((m) => m.gene), ...r.genes.map((g) => g.entry.gene)].join(" ").toLowerCase().includes(needle);
}

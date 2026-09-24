// Accuracy audit: how every evidence-bearing row of the file was linked and checked.
// Counts are per unique evidence site, so a site with several ClinVar records counts once.
import type { GenomeTable, ParsedGenome, SiteMatch } from "./types";

export interface MatchAudit {
  rowsInFile: number;
  sites: number; // evidence sites found in the file
  byRsid: number;
  byPosition: number; // linked by chromosome + position (e.g. 23andMe "i" IDs, outdated rsIDs)
  posChecked: number;
  posMismatch: number;
  forward: number;
  complemented: number;
  palindromic: number;
  indel: number;
  alleleMismatch: number;
  noCall: number;
  examples: { kind: "position" | "alleles"; site: string; fileId: string; detail: string }[];
  seen: Set<string>;
  /** File row IDs that carry evidence (for the raw-data table). */
  fileIds: Set<string>;
}

export const newAudit = (rowsInFile = 0): MatchAudit => ({
  rowsInFile, sites: 0, byRsid: 0, byPosition: 0, posChecked: 0, posMismatch: 0, forward: 0, complemented: 0, palindromic: 0, indel: 0, alleleMismatch: 0, noCall: 0, examples: [], seen: new Set(), fileIds: new Set(),
});

export function recordAudit(a: MatchAudit, m: SiteMatch) {
  if (m.status === "not-on-array" || !m.call || a.seen.has(m.site.rsid)) return;
  a.seen.add(m.site.rsid);
  a.fileIds.add(m.call.rsid);
  a.sites++;
  if (m.call.matchedBy === "position") a.byPosition++; else a.byRsid++;
  if (m.positionCheck !== "not-checked") a.posChecked++;
  if (m.positionCheck === "mismatch") {
    a.posMismatch++;
    if (a.examples.length < 40) a.examples.push({ kind: "position", site: `${m.site.label} (${m.site.rsid})`, fileId: m.call.rsid, detail: `file ${m.call.chrom}:${m.call.pos}, reference ${m.site.chrom}:${m.site.pos37}` });
  }
  if (m.status === "no-call") { a.noCall++; return; }
  if (m.status === "allele-mismatch") {
    a.alleleMismatch++;
    if (a.examples.length < 40) a.examples.push({ kind: "alleles", site: `${m.site.label} (${m.site.rsid})`, fileId: m.call.rsid, detail: `file ${m.call.raw}, reference ${m.site.ref}/${m.site.alts.join(",")}. At sites with several known alleles this usually means you carry a different allele than the one this record describes` });
    return;
  }
  if (m.orientation === "forward") a.forward++;
  else if (m.orientation === "complemented") a.complemented++;
  else if (m.orientation === "ambiguous-palindromic") a.palindromic++;
  else if (m.orientation === "indel-coded") a.indel++;
}

/** Serializable form (drops the Set). */
export const auditSummary = ({ seen: _s, fileIds, ...rest }: MatchAudit) => ({ ...rest, fileIds: [...fileIds] });
export type AuditSummary = ReturnType<typeof auditSummary>;

export interface PositionCandidate { rsid: string; chrom: string; pos: number | null; alleles: string[] }


/**
 * Link file rows to evidence sites by chromosome and GRCh37 position when the rsID is not in the
 * file (23andMe internal "i" IDs, merged rsIDs). SNV rows only (indel position conventions differ
 * between vendors), and only when the row's alleles fit the site's alleles on either strand.
 */
export function linkByPosition(genome: ParsedGenome, candidates: PositionCandidate[]): number {
  const t: GenomeTable | undefined = genome.table;
  if (!t || genome.build !== "GRCh37") return 0;
  const index = new Map<string, number>();
  for (let i = 0; i < t.id.length; i++) if (/^[ACGT]{1,2}$/.test(t.geno[i])) index.set(`${t.chrom[i]}:${t.pos[i]}`, i);
  let n = 0;
  for (const c of candidates) {
    if (c.pos == null || genome.calls.has(c.rsid)) continue;
    const i = index.get(`${c.chrom}:${c.pos}`);
    if (i == null) continue;
    const obs = t.geno[i].split("");
    // Forward strand only: consumer files report the forward strand, and flipping could turn a
    // different allele into a disease allele.
    const fits = obs.every((x) => c.alleles.includes(x));
    if (!fits || !c.alleles.every((x) => /^[ACGT]$/.test(x))) continue;
    genome.calls.set(c.rsid, { rsid: t.id[i], chrom: t.chrom[i], pos: t.pos[i], alleles: obs, raw: t.geno[i], matchedBy: "position" });
    n++;
  }
  return n;
}

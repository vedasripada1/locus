// Gene guide: reads each curated gene's sites from the file and picks the plain-language reading
// that applies. Readings are fixed, verified text (pipeline/genes.ts); nothing is generated here.
// A site that isn't on the chip or can't be read is never treated as "not carried".
import { countAllele, matchSite } from "./match";
import type { EvidenceBundle, GeneGuideEntry, GeneReading, GeneResult, GeneSiteResult, ParsedGenome, SiteMatch, VariantSite } from "./types";

const inRange = (n: number, spec: number | [number, number]) => (Array.isArray(spec) ? n >= spec[0] && n <= spec[1] : n === spec);

/**
 * Does a reading's condition hold? rsID keys need that site read. "total" sums the copies over read
 * sites: a lower bound of 1+ can be met by the sites that were read (carrying is certain), but
 * "total 0" needs every site read. An empty condition needs at least one site read.
 */
export function holds(r: GeneReading, sites: GeneSiteResult[]): boolean {
  const read = sites.filter((s) => s.copies != null);
  if (!read.length) return false;
  for (const [key, spec] of Object.entries(r.if)) {
    if (key === "total") {
      const sum = read.reduce((a, s) => a + s.copies!, 0);
      const [lo, hi] = Array.isArray(spec) ? spec : [spec, spec];
      if (read.length === sites.length ? !(sum >= lo && sum <= hi) : !(lo >= 1 && sum >= lo && sum <= hi)) return false;
    } else {
      const s = sites.find((x) => x.rsid === key);
      if (s?.copies == null || !inRange(s.copies, spec)) return false;
    }
  }
  return true;
}

export function geneResult(entry: GeneGuideEntry, matchOf: (rsid: string) => SiteMatch): GeneResult {
  const sites = entry.sites.map((s) => { const match = matchOf(s.rsid); return { rsid: s.rsid, match, copies: countAllele(match, s.allele) }; });
  const nRead = sites.filter((s) => s.copies != null).length;
  return {
    entry, sites,
    reading: entry.readings.find((r) => holds(r, sites)) ?? null,
    status: nRead === sites.length ? "read" : nRead ? "partial" : "not-tested",
  };
}

/** Every site the gene guide reads (dbSNP-verified), deduplicated; the worker must keep these rows. */
export function guideSites(bundle: EvidenceBundle): VariantSite[] {
  const g = bundle.geneGuide;
  if (!g) return [];
  const out = new Map<string, VariantSite>();
  for (const s of [...g.entries.flatMap((e) => e.sites.map((x) => x.site)), ...g.unsupported.map((u) => u.site)]) if (!out.has(s.rsid)) out.set(s.rsid, s);
  return [...out.values()];
}

/** Gene guide results for a file, plus site matches for intervention triggers. */
export function geneResults(genome: ParsedGenome, bundle: EvidenceBundle): { results: GeneResult[]; matches: Map<string, SiteMatch> } {
  const matches = new Map<string, SiteMatch>();
  const guide = bundle.geneGuide;
  if (!guide) return { results: [], matches };
  const matchOf = (rsid: string) => {
    let m = matches.get(rsid);
    if (!m) {
      const site = guide.entries.flatMap((e) => e.sites).find((s) => s.rsid === rsid)?.site ?? guide.unsupported.find((u) => u.rsid === rsid)!.site;
      m = matchSite(genome, site);
      matches.set(rsid, m);
    }
    return m;
  };
  const results = guide.entries.map((e) => geneResult(e, matchOf));
  for (const u of guide.unsupported) matchOf(u.rsid);
  return { results, matches };
}

/** Plain genotype line for one site, e.g. "rs1801133: AA (two copies of 677T)". */
export function siteLine(s: GeneSiteResult, alleleName: string, allele: string): string {
  const m = s.match;
  if (m.status === "not-on-array") return `${s.rsid}: not on your chip`;
  if (m.status === "no-call") return `${s.rsid}: on your chip, but not read (no-call)`;
  if (m.status !== "matched" || s.copies == null) return `${s.rsid}: couldn't be read reliably (${m.call?.raw ?? "?"})`;
  const g = m.forwardAlleles.join("");
  const copies = m.forwardAlleles.length === 1 ? (s.copies ? "one copy" : "no copy") : ["no copies", "one copy", "two copies"][s.copies];
  const flip = m.orientation === "complemented" ? `, read from the other strand as ${m.call!.raw}` : "";
  return `${s.rsid}: ${g} (${copies} of ${allele}, ${alleleName}${flip})`;
}

import type { GenotypeCall, Orientation, ParsedGenome, SiteMatch, VariantSite } from "./types";

const COMPLEMENT: Record<string, string> = { A: "T", T: "A", C: "G", G: "C" };

export const complement = (a: string) => COMPLEMENT[a] ?? a;

/** A/T or C/G pair (ref vs main alternate): the two strands look identical. */
export function isPalindromic(site: Pick<VariantSite, "ref" | "mainAlt" | "kind">): boolean {
  return site.kind === "snv" && complement(site.ref) === site.mainAlt;
}

/** Rewrite a single allele reported by a source onto the site's forward strand. */
export function orientAllele(
  allele: string,
  site: Pick<VariantSite, "ref" | "alts" | "mainAlt" | "kind">,
): { allele: string | null; how: "forward" | "complemented" | "ambiguous" | "unresolvable" } {
  // Orient against the main biallelic pair: a study allele that only matches a rare third
  // dbSNP allele is far more likely to be the main pair reported on the other strand.
  const pair = [site.ref, site.mainAlt];
  if (site.kind !== "snv") return [site.ref, ...site.alts].includes(allele) ? { allele, how: "forward" } : { allele: null, how: "unresolvable" };
  if (isPalindromic(site)) return pair.includes(allele) ? { allele, how: "ambiguous" } : { allele: null, how: "unresolvable" };
  if (pair.includes(allele)) return { allele, how: "forward" };
  if (pair.includes(complement(allele))) return { allele: complement(allele), how: "complemented" };
  return { allele: null, how: "unresolvable" };
}

/** For indel sites, what does a vendor's I or D mean in forward-strand alleles? */
function indelToForward(a: string, site: VariantSite): string | null {
  const alt = site.alts[0];
  if (site.kind === "deletion") return a === "D" ? alt : a === "I" ? site.ref : null;
  if (site.kind === "insertion") return a === "I" ? alt : a === "D" ? site.ref : null;
  return null;
}

export function findCall(genome: ParsedGenome, site: VariantSite): GenotypeCall | undefined {
  for (const id of [site.rsid, ...site.aliases]) {
    const c = genome.calls.get(id);
    if (c) return c;
  }
  return undefined;
}

/**
 * Match one evidence site. `forwardOnly` (used for clinical calls) never flips strands:
 * consumer files report the forward strand, so a genotype that only fits after flipping more
 * likely carries a different allele, and must not be turned into a disease allele.
 */
export function matchSite(genome: ParsedGenome, site: VariantSite, opts: { forwardOnly?: boolean } = {}): SiteMatch {
  const base: SiteMatch = { site, status: "not-on-array", call: null, forwardAlleles: [], orientation: null, positionCheck: "not-checked", notes: [] };
  const call = findCall(genome, site);
  if (!call) {
    base.notes.push("This variant is not in your file. That is not a negative result: it was simply not tested.");
    return base;
  }
  const m: SiteMatch = { ...base, call };
  if (call.matchedBy === "position") m.notes.push(`Matched by chromosome and position: your file lists this site as ${call.rsid}. Alleles were checked for consistency.`);
  else if (call.rsid !== site.rsid) m.notes.push(`Found under merged rsID ${call.rsid}; dbSNP now calls it ${site.rsid}.`);

  const expectedPos = genome.build === "GRCh37" ? site.pos37 : genome.build === "GRCh38" ? site.pos38 : null;
  if (expectedPos != null) {
    m.positionCheck = call.pos === expectedPos && call.chrom === site.chrom ? "ok" : "mismatch";
    if (m.positionCheck === "mismatch") {
      m.notes.push(`File position ${call.chrom}:${call.pos} differs from the ${genome.build} reference ${site.chrom}:${expectedPos}. Matched by rsID only; treat with caution.`);
    }
  }

  if (call.alleles.length === 0) {
    m.status = "no-call";
    m.notes.push(`The chip tested this site but could not read it (${call.raw}). Unknown, not negative.`);
    return m;
  }

  const isIndelCall = call.alleles.some((a) => a === "I" || a === "D");
  if (isIndelCall || site.kind !== "snv") {
    if (!isIndelCall || site.kind === "snv" || site.kind === "other") {
      m.status = "allele-mismatch";
      m.notes.push(`File reports ${call.raw}, which cannot be mapped onto this ${site.kind} site.`);
      return m;
    }
    const fwd = call.alleles.map((a) => indelToForward(a, site));
    if (fwd.some((a) => a == null)) {
      m.status = "allele-mismatch";
      return m;
    }
    m.status = "matched";
    m.orientation = "indel-coded";
    m.forwardAlleles = fwd as string[];
    m.notes.push("Insertion/deletion calls on consumer chips have high error rates. Any result here needs confirmation.");
    return m;
  }

  const known = [site.ref, ...site.alts];
  let orientation: Orientation;
  let forward = call.alleles;
  if (isPalindromic(site)) {
    orientation = "ambiguous-palindromic";
    m.notes.push(`${site.ref}/${site.mainAlt} is a palindromic (strand-ambiguous) pair. We assume the vendor reports the forward strand, as both vendors document, but this cannot be checked from the alleles.`);
    if (!call.alleles.every((a) => known.includes(a))) {
      m.status = "allele-mismatch";
      m.notes.push(`Observed ${call.raw} is not among the known alleles ${known.join("/")}.`);
      return m;
    }
  } else if (call.alleles.every((a) => known.includes(a))) {
    orientation = "forward";
  } else if (!opts.forwardOnly && call.alleles.every((a) => known.includes(complement(a)))) {
    orientation = "complemented";
    forward = call.alleles.map(complement);
    m.notes.push(`Reported on the opposite strand (${call.raw}); complemented to ${forward.join("")}.`);
  } else {
    m.status = "allele-mismatch";
    m.notes.push(opts.forwardOnly
      ? `Observed ${call.raw} does not match this record's alleles ${known.join("/")} on the forward strand (the strand consumer files use). You likely carry a different allele; not interpreted, and never flipped for a clinical call.`
      : `Observed ${call.raw} does not match the known alleles ${known.join("/")} on either strand. Not interpreted.`);
    return m;
  }
  m.status = "matched";
  m.orientation = orientation;
  m.forwardAlleles = forward;
  if (forward.length === 1) m.notes.push("Single allele reported (hemizygous region, e.g. X in males).");
  return m;
}

/** Copies of `allele` in the forward genotype; null if unknown. */
export function countAllele(m: SiteMatch, allele: string | null): number | null {
  if (m.status !== "matched" || allele == null) return null;
  return m.forwardAlleles.filter((a) => a === allele).length;
}

export function zygosity(m: SiteMatch, copies: number | null) {
  if (copies == null) return "unknown" as const;
  if (copies === 0) return "not carried" as const;
  if (m.forwardAlleles.length === 1) return "hemizygous" as const;
  return copies === 2 ? ("homozygous" as const) : ("heterozygous" as const);
}

/** Plain description of one allele at a site, e.g. "G", "deletion of CTT", "insertion of C". */
export function describeAllele(site: Pick<VariantSite, "ref" | "kind">, allele: string): string {
  if (site.kind === "snv" || allele === site.ref) return allele === site.ref && site.kind !== "snv" ? "no deletion/insertion (reference)" : allele;
  const ref = site.ref === "-" ? "" : site.ref, alt = allele === "-" ? "" : allele;
  if (alt.length < ref.length) return `deletion of ${ref.startsWith(alt) ? ref.slice(alt.length) : ref}`;
  if (alt.length > ref.length) return `insertion of ${alt.startsWith(ref) ? alt.slice(ref.length) : alt}`;
  return allele;
}

/** Your genotype in plain words, including what I/D codes mean. */
export function readableGenotype(m: SiteMatch): string {
  if (m.status === "not-on-array") return "Not on your chip (not tested).";
  if (m.status === "no-call") return "On your chip, but the reading failed (no-call).";
  if (m.status === "allele-mismatch") return `Unreadable against the reference (${m.call?.raw}).`;
  const a = m.forwardAlleles;
  if (m.orientation === "indel-coded") {
    const variant = a.filter((x) => x !== m.site.ref).length;
    const what = describeAllele(m.site, m.site.alts[0]);
    const codes = `${m.call!.raw}: your file uses I/D codes (I = insertion, D = deletion)`;
    if (variant === 0) return `${codes}. Neither copy has the ${what}.`;
    return `${codes}. ${variant === 2 ? "Both copies have" : "One copy has"} the ${what}${variant === 1 ? "; the other doesn't" : ""}.`;
  }
  const flipped = m.orientation === "complemented" ? ` (your file reports the opposite DNA strand: ${m.call!.raw})` : "";
  if (a.length === 1) return `${a[0]} (a single copy, as expected on X/Y/mitochondrial DNA in some people)${flipped}.`;
  return a[0] === a[1] ? `${a.join("")}: two copies of ${a[0]}${flipped}.` : `${a.join("")}: one ${a[0]} and one ${a[1]}${flipped}.`;
}

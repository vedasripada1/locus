// Before any clinical alarm: verify the disease-causing allele, that it is really present in the
// file, that ClinVar classifies it pathogenic with adequate review, that it is rare enough to cause
// disease, and whether (given inheritance) it could affect this person or makes them a carrier.
import { classifyClinVar } from "./interpret";
import { describeAllele } from "./match";
import type { ClinicalFinding } from "./types";

export type CheckStatus = "pass" | "caution" | "fail" | "unknown";
export interface Check { label: string; status: CheckStatus; detail: string }
export type AlarmLevel = "alarm" | "carrier" | "unclear" | "not-a-concern";
export interface ClinicalVerdict { checks: Check[]; level: AlarmLevel; reason: string; moi: string | null; frequency: number | null }

/** [minor allele, global minor-allele frequency, "REF/ALT1/ALT2"] from Ensembl (1000 Genomes). */
export type FreqEntry = [string, number, string];

export const RARE = 0.01;
export const TOO_COMMON = 0.05;

/** Frequency of the ClinVar (disease) allele itself, when it can be worked out; null otherwise. */
export function altFrequency(entry: FreqEntry | undefined, ref: string, alt: string): number | null {
  if (!entry) return null;
  const [minor, maf, alleles] = entry;
  const all = alleles.split("/");
  if (minor === "" && maf === 0) return all.includes(alt) ? 0 : null; // known variant, never seen in 1000 Genomes
  if (minor === alt) return maf;
  if (minor === ref && all.length === 2) return 1 - maf; // biallelic: the disease allele is the major one
  return null; // multi-allelic and the minor allele is a third allele: unknown
}

/** Inheritance stated in GeneReviews' genetic-counseling text, if exactly one pattern is named. */
export function moiFromText(text: string | undefined): string | null {
  if (!text) return null;
  const found = new Set<string>();
  if (/autosomal recessive/i.test(text)) found.add("AR");
  if (/autosomal dominant/i.test(text)) found.add("AD");
  if (/X-linked recessive/i.test(text)) found.add("XLR");
  else if (/X-linked dominant/i.test(text)) found.add("XLD");
  else if (/X-linked/i.test(text)) found.add("XL");
  return found.size === 1 ? [...found][0] : null;
}

const pct = (x: number) => (x < 0.001 ? "under 0.1%" : `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`);

export function verifyClinical(f: ClinicalFinding, moi: string | null, frequency: number | null): ClinicalVerdict {
  const m = f.match, r = f.record, site = m.site;
  const checks: Check[] = [];

  // 1. The disease-causing allele, from ClinVar.
  checks.push({ label: "Disease-causing allele identified", status: "pass",
    detail: `ClinVar: ${describeAllele(site, r.altAllele)} at chromosome ${site.chrom}, position ${site.pos37?.toLocaleString() ?? "?"} (GRCh37); ${r.title}.` });

  // 2. Really present in the file.
  const copies = f.altCopies ?? 0;
  let present: Check;
  if (!copies) present = { label: "Present in your file", status: "fail", detail: "Your file does not show this allele." };
  else if (m.orientation === "ambiguous-palindromic") present = { label: "Present in your file", status: "caution", detail: `Your file shows ${m.call!.raw}, but at an A/T or C/G site the strand can't be checked from the letters alone.` };
  else if (m.positionCheck === "mismatch") present = { label: "Present in your file", status: "fail", detail: `Your file lists this ID at ${m.call!.chrom}:${m.call!.pos}, but the ClinVar variant is at ${site.chrom}:${site.pos37}. It's probably a different variant, so it isn't counted.` };
  else if (m.orientation === "indel-coded") present = indelPresence(f);
  else present = { label: "Present in your file", status: "pass", detail: `Your file shows ${m.call!.raw} on the forward strand at the expected position: ${copies === 2 ? "two copies" : m.forwardAlleles.length === 1 ? "one copy (single-copy region)" : "one copy"}.` };
  checks.push(present);

  // 3. Classified pathogenic, with adequate review and no conflicts.
  const kind = classifyClinVar(r).kind;
  const cls: Check = kind === "conflicting" ? { label: "Classified disease-causing", status: "fail", detail: `ClinVar submitters disagree ("${r.classification}").` }
    : kind !== "pathogenic" ? { label: "Classified disease-causing", status: "fail", detail: `ClinVar classification is "${r.classification}", not pathogenic.` }
    : r.stars < 2 && !r.rcvs.some((x) => x.stars >= 2 && /pathogenic/i.test(x.classification) && !/conflicting/i.test(x.classification))
      ? { label: "Classified disease-causing", status: "caution", detail: `"${r.classification}" from a single submitter (${r.stars}★): not independently confirmed.` }
      : { label: "Classified disease-causing", status: "pass", detail: `"${r.classification}", ${r.stars}★ review (${r.reviewStatus}), no conflicting interpretations.` };
  checks.push(cls);

  // 4. Rare enough to cause disease on its own.
  const freq: Check = frequency == null
    ? { label: "Rare in the population", status: "unknown", detail: "No population frequency available for this allele." }
    : frequency >= TOO_COMMON
      ? { label: "Rare in the population", status: "fail", detail: `About ${pct(frequency)} of alleles worldwide are this one (1000 Genomes). An allele this common can't on its own cause a rare disease; ClinVar's label likely reflects a low-impact or mislabelled variant.` }
      : frequency >= RARE
        ? { label: "Rare in the population", status: "caution", detail: `About ${pct(frequency)} of alleles worldwide (1000 Genomes): fairly common. Variants this common are often recessive carrier variants or have low penetrance.` }
        : frequency === 0
          ? { label: "Rare in the population", status: "pass", detail: "Not seen in 1000 Genomes (2,504 people from 26 populations): rare worldwide, as expected for a disease-causing variant. Some variants are more common within particular communities." }
          : { label: "Rare in the population", status: "pass", detail: `About ${pct(frequency)} of alleles worldwide (1000 Genomes), as expected for a disease-causing variant.` };
  checks.push(freq);

  // 5. Could it affect you, given inheritance?
  const two = copies === 2 || (copies === 1 && m.forwardAlleles.length === 1); // homozygous or hemizygous
  let effect: Check, carrier = false;
  if (moi === "AR") { carrier = !two; effect = two ? { label: "Could it affect you?", status: "pass", detail: "Recessive condition and you appear to have two copies, so it could affect you if confirmed." } : { label: "Could it affect you?", status: "pass", detail: "Recessive condition and you appear to have one copy: that makes you a carrier. Carriers usually have no symptoms." }; }
  else if (moi === "XLR" || moi === "XL") { carrier = !two; effect = two ? { label: "Could it affect you?", status: "pass", detail: "X-linked condition and your file shows a single-copy or two-copy genotype, so it could affect you if confirmed." } : { label: "Could it affect you?", status: "pass", detail: "X-linked condition and you appear to have one copy of two: usually carrier status (mainly relevant to children)." }; }
  else if (moi === "AD" || moi === "SD" || moi === "XLD") effect = { label: "Could it affect you?", status: "pass", detail: "Dominant condition: one copy can be enough, if confirmed." };
  else effect = { label: "Could it affect you?", status: "unknown", detail: "How this condition is inherited isn't recorded in ClinGen or GeneReviews, so whether one copy matters is unclear." };
  checks.push(effect);

  // One of each I/D code can't be tied to this exact change from consumer data: never an alarm.
  const indelHet = m.orientation === "indel-coded" && present.status === "caution";

  const failed = checks.find((c) => c.status === "fail");
  const weakClass = cls.status === "caution";
  if (failed || weakClass) {
    return { checks, level: "not-a-concern", moi, frequency, reason: failed ? failed.detail : cls.detail };
  }
  // Unknown inheritance with one copy: it may only mean carrier status, so don't alarm.
  if (effect.status === "unknown" && !two) return { checks, level: "unclear", moi, frequency, reason: effect.detail };
  if (indelHet) return { checks, level: carrier ? "carrier" : "unclear", moi, frequency, reason: present.detail };
  return { checks, level: carrier ? "carrier" : "alarm", moi, frequency, reason: effect.detail };
}

/**
 * AncestryDNA and 23andMe write insertions/deletions as I (longer version) and D (shorter version).
 * Which one is normal depends on the site and isn't stated in the file, and one rsID can cover
 * several different indels. So:
 *  - two identical codes (DD / II) are never counted as two copies of a disease variant: for a rare
 *    disease allele, being homozygous is far less likely than the code meaning the normal version;
 *  - one of each (DI) can't be tied to this exact change, so it is at most "unclear" or carrier.
 */
function indelPresence(f: ClinicalFinding): Check {
  const raw = f.match.call!.raw;
  const what = describeAllele(f.match.site, f.record.altAllele);
  const codes = "Consumer files write insertions and deletions as I (the longer version) and D (the shorter version); which one is normal depends on the site, and the file doesn't say.";
  if ((f.altCopies ?? 0) === 2) {
    return { label: "Present in your file", status: "fail",
      detail: `Your file shows ${raw}. ${codes} This disease change (${what}) is rare, so two copies would be extremely unusual: ${raw} here almost certainly means you have the normal version on both copies. Not counted.` };
  }
  return { label: "Present in your file", status: "caution",
    detail: `Your file shows ${raw}: one copy of each version. ${codes} So it can't be confirmed from this file that you carry this exact change (${what}); only a clinical test can tell.` };
}

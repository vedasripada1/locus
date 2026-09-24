import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { matchSite } from "../src/core/match";
import { clinicalFinding } from "../src/core/interpret";
import { freqFor, moiFromText, verifyClinical, type AlleleFreq } from "../src/core/clinicalcheck";

/** Frequency helper: global AF, optional higher continental AF. */
const F = (af: number, maxAf = af, pop = af ? "EUR" : ""): AlleleFreq => ({ af, maxAf, pop });
import { screenClinVar, type BulkClinVarFile } from "../src/core/bulk";
import { linkByPosition } from "../src/core/audit";
import { confirmItem } from "../src/core/plain";
import { BUNDLE, file23, site } from "./fixtures";
import type { ClinVarRecord } from "../src/core/types";

const S = site({ rsid: "rs700", gene: "GENEX", chrom: "3", pos37: 700, ref: "A", alts: ["G"], domain: "clinical", label: "GENEX test" });
const rec = (p: Partial<ClinVarRecord> = {}): ClinVarRecord => ({
  kind: "clinvar", id: "VCV1", rsid: "rs700", title: "NM_1(GENEX):c.1A>G", altAllele: "G", classification: "Pathogenic", reviewStatus: "criteria provided, multiple submitters, no conflicts",
  stars: 2, conflicting: false, conditions: ["Rare disease X"], rcvs: [], lastEvaluated: null, url: "https://example.test", source: BUNDLE.clinvar[0].source, ...p,
});
const finding = (geno: string, r = rec()) => {
  const g = parseGenotypeText(file23([["rs700", "3", 700, geno]]), new Set(["rs700"]));
  return clinicalFinding(matchSite(g, S, { forwardOnly: true }), r, { clingen: [] } as never);
};

describe("no alarm unless the disease allele is present, pathogenic, rare, and could affect you", () => {
  it("raises a rare, well-reviewed, dominant variant", () => {
    const v = verifyClinical(finding("AG"), "AD", F(0.003));
    expect(v.level).toBe("alarm");
    expect(v.checks.every((c) => c.status === "pass")).toBe(true);
    expect(v.checks[0].detail).toMatch(/ClinVar: G at chromosome 3, position 700 \(GRCh37\)/);
  });
  it("never alarms on a common allele, whatever ClinVar says", () => {
    const v = verifyClinical(finding("GG"), "AD", F(0.21));
    expect(v.level).toBe("not-a-concern");
    expect(v.reason).toMatch(/can't on its own cause a rare disease/);
  });
  it("treats 1–5% frequency as a caution, not a failure", () => {
    expect(verifyClinical(finding("AG"), "AD", F(0.03)).checks[3].status).toBe("caution");
  });
  it("does not alarm on conflicting, benign or single-submitter classifications", () => {
    expect(verifyClinical(finding("AG", rec({ classification: "Conflicting classifications of pathogenicity", conflicting: true, stars: 1 })), "AD", F(0.001)).level).toBe("not-a-concern");
    expect(verifyClinical(finding("AG", rec({ classification: "Benign", stars: 2 })), "AD", F(0.001)).level).toBe("not-a-concern");
    expect(verifyClinical(finding("AG", rec({ stars: 1, reviewStatus: "criteria provided, single submitter" })), "AD", F(0.001)).level).toBe("not-a-concern");
  });
  it("separates carriers from people who could be affected", () => {
    expect(verifyClinical(finding("AG"), "AR", F(0.002)).level).toBe("carrier");
    expect(verifyClinical(finding("GG"), "AR", F(0.02)).level).toBe("alarm");
    expect(verifyClinical(finding("AG"), "XLR", F(0.002)).level).toBe("carrier");
    expect(verifyClinical(finding("G"), "XLR", F(0.002)).level).toBe("alarm"); // single-copy (hemizygous)
  });
  it("does not alarm on one copy when inheritance is unknown, but still raises two copies", () => {
    const v = verifyClinical(finding("AG"), null, F(0.001));
    expect(v.checks[4].status).toBe("unknown");
    expect(v.level).toBe("unclear");
    expect(verifyClinical(finding("GG"), null, F(0.02)).level).toBe("alarm");
  });
});

describe("strand safety", () => {
  it("never flips a genotype into the disease allele", () => {
    // Site A>G. A file reading CC could only 'match' by flipping to GG; it must not be counted.
    const f = finding("CC");
    expect(f.match.status).toBe("allele-mismatch");
    expect(f.altCopies).toBeNull();
    const cv: BulkClinVarFile = { version: "t", retrievedAt: "t", genes: ["GENEX"], conditions: ["Rare disease X"], sigs: ["Pathogenic"], rows: [[700, "3", 700, "A", "G", 0, 2, 0, [0], 9, "", "NM_1(GENEX):c.1A>G"]], cites: {} };
    const g = parseGenotypeText(file23([["rs700", "3", 700, "CC"]]), new Set(["rs700"]));
    expect(screenClinVar(g, cv, []).carried).toHaveLength(0);
  });
  it("does not count a file row whose position differs from the ClinVar variant", () => {
    const g = parseGenotypeText(file23([["rs700", "3", 999, "AG"]]), new Set(["rs700"]));
    const f = clinicalFinding(matchSite(g, S, { forwardOnly: true }), rec(), { clingen: [] } as never);
    const v = verifyClinical(f, "AD", F(0));
    expect(v.level).toBe("not-a-concern");
    expect(v.reason).toMatch(/probably a different variant/);
  });
  it("links by position only on the forward strand", () => {
    const g = parseGenotypeText(file23([["i9", "3", 700, "CC"]]), new Set(), { fullTable: true });
    expect(linkByPosition(g, [{ rsid: "rs700", chrom: "3", pos: 700, alleles: ["A", "G"] }])).toBe(0);
  });
});

describe("frequency and inheritance sources", () => {
  it("looks up the disease allele's own frequency, including at multi-allelic sites", () => {
    const table = { rs6025: { T: [0.00599, 0.0119, "EUR"] as [number, number, string] }, rs80357346: { C: [0, 0, ""] as [number, number, string] } };
    expect(freqFor(table, "rs6025", "T")).toEqual({ af: 0.00599, maxAf: 0.0119, pop: "EUR" }); // Factor V Leiden, site T/C/A
    expect(freqFor(table, "rs80357346", "C")).toEqual({ af: 0, maxAf: 0, pop: "" }); // not observed in 1000 Genomes
    expect(freqFor(table, "rs6025", "A")).toBeNull();
    // F508del: dbSNP-style TCTT>T has no 1000G entry, but VCF-style ATCT>A (same 3-base deletion) does.
    const cf = { rs113993960: { A: [0.004, 0.0101, "AMR", "ATCT"] as [number, number, string, string], T: [0, 0, "", "TCTT"] as [number, number, string, string] } };
    expect(freqFor(cf, "rs113993960", "T", "TCTT")).toEqual({ af: 0.004, maxAf: 0.0101, pop: "AMR" });
    expect(verifyClinical(finding("AG"), "AD", F(0)).checks[3].detail).toMatch(/Not observed in 1000 Genomes/);
  });
  it("uses the highest continental frequency for plausibility, the global one for 'too common'", () => {
    // Global 1.3% but 6% in one group: two copies are believable, and it is a caution, not 'too common'.
    const v = verifyClinical(finding("GG"), "AR", F(0.013, 0.06));
    expect(v.level).toBe("alarm");
    expect(v.checks[3].status).toBe("caution");
    expect(v.checks[3].detail).toMatch(/up to 6\.0% in European samples/);
  });
  it("reads inheritance from GeneReviews text only when unambiguous", () => {
    expect(moiFromText("HFE HC is inherited in an autosomal recessive manner.")).toBe("AR");
    expect(moiFromText("Inherited in an autosomal dominant or autosomal recessive manner.")).toBeNull();
  });
  it("labels a reviewed-but-benign result calmly and hides it by default", () => {
    const item = confirmItem(finding("GG"), true, null, [], { rs700: { G: [0.8, 0.9, "AFR"] } }); // G is 80% frequent
    expect(item.title).toMatch(/^Reviewed, not a concern/);
    expect(item.sufficient).toBe(false);
    expect(item.tone).toBe("clear");
  });
});

describe("insertion/deletion (I/D) codes never raise false alarms", () => {
  const DEL = site({ rsid: "rs800", gene: "GENED", chrom: "7", pos37: 800, ref: "ACTT", alts: ["A"], kind: "deletion", domain: "clinical", label: "GENED del" });
  const delRec = rec({ rsid: "rs800", altAllele: "A", title: "NM_2(GENED):c.3_5del" });
  const indel = (geno: string) => {
    const g = parseGenotypeText(file23([["rs800", "7", 800, geno]]), new Set(["rs800"]));
    return clinicalFinding(matchSite(g, DEL, { forwardOnly: true }), delRec, { clingen: [] } as never);
  };
  it("does not count D D as two copies of a rare disease deletion, and says why", () => {
    const v = verifyClinical(indel("DD"), "AD", F(0));
    expect(v.level).toBe("not-a-concern");
    expect(v.checks[1].status).toBe("fail");
    expect(v.checks[1].detail).toMatch(/I \(the longer version\) and D \(the shorter version\).*almost certainly means you have the normal version on both copies/);
  });
  it("never alarms on D I, even for a dominant condition", () => {
    const v = verifyClinical(indel("DI"), "AD", F(0.003));
    expect(v.level).toBe("unclear");
    expect(v.checks[1].detail).toMatch(/can't be confirmed from this file that you carry this exact change \(deletion of CTT\)/);
  });
  it("treats D I for a recessive condition as carrier at most", () => {
    expect(verifyClinical(indel("DI"), "AR", F(0.003)).level).toBe("carrier");
  });
  it("does not repeat the genotype explanation in the rationale", () => {
    const item = confirmItem(indel("DI"), true, null, [], {});
    expect(item.why.some((w) => /^Your genotype/.test(w))).toBe(false);
    expect(item.checks!.filter((c) => /I \(the longer version\)/.test(c.detail))).toHaveLength(1);
  });
});

describe("plausibility: no alarm on calls a consumer chip can't be trusted with", () => {
  // The reported case: BRCA1 c.1292T>G (p.Leu431Ter), forward A>C, never seen in 1000 Genomes; file shows C C.
  const B = site({ rsid: "rs80357346", gene: "BRCA1", chrom: "17", pos37: 41246256, ref: "A", alts: ["C", "T"], domain: "clinical", label: "BRCA1 c.1292T>G" });
  const brec = rec({ rsid: "rs80357346", altAllele: "C", title: "NM_007294.4(BRCA1):c.1292T>G (p.Leu431Ter)", stars: 3, conditions: ["Fanconi anemia, complementation group S", "Hereditary breast ovarian cancer syndrome"] });
  const call = (geno: string) => {
    const g = parseGenotypeText(file23([["rs80357346", "17", 41246256, geno]]), new Set(["rs80357346"]));
    return clinicalFinding(matchSite(g, B, { forwardOnly: true }), brec, { clingen: [] } as never);
  };
  it("does not count two copies of an ultra-rare allele (the C C case)", () => {
    const v = verifyClinical(call("CC"), "AR", F(0));
    expect(v.level).toBe("not-a-concern");
    expect(v.reason).toMatch(/far fewer than 1 in 40,000 people.*almost certainly a chip reading error/);
  });
  it("sets aside a single very rare call as unverified, not a finding", () => {
    expect(verifyClinical(call("AC"), "AD", F(0)).level).toBe("unverified");
    expect(verifyClinical(call("AC"), "AD", null).level).toBe("unverified");
    const item = confirmItem(call("AC"), true, null, [], { rs80357346: { C: [0, 0, ""] } });
    expect(item.sufficient).toBe(false);
    expect(item.title).toMatch(/^Unverified rare call: BRCA1/);
  });
  it("still raises chip-reliable variants that pass every check", () => {
    expect(verifyClinical(call("AC"), "AD", F(0.006)).level).toBe("alarm"); // e.g. Factor V Leiden-like frequency
  });
});

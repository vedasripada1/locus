import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { matchSite } from "../src/core/match";
import { clinicalFinding } from "../src/core/interpret";
import { altFrequency, moiFromText, verifyClinical } from "../src/core/clinicalcheck";
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
    const v = verifyClinical(finding("AG"), "AD", 0.0004);
    expect(v.level).toBe("alarm");
    expect(v.checks.every((c) => c.status === "pass")).toBe(true);
    expect(v.checks[0].detail).toMatch(/ClinVar: G at chromosome 3, position 700 \(GRCh37\)/);
  });
  it("never alarms on a common allele, whatever ClinVar says", () => {
    const v = verifyClinical(finding("GG"), "AD", 0.21);
    expect(v.level).toBe("not-a-concern");
    expect(v.reason).toMatch(/can't on its own cause a rare disease/);
  });
  it("treats 1–5% frequency as a caution, not a failure", () => {
    expect(verifyClinical(finding("AG"), "AD", 0.03).checks[3].status).toBe("caution");
  });
  it("does not alarm on conflicting, benign or single-submitter classifications", () => {
    expect(verifyClinical(finding("AG", rec({ classification: "Conflicting classifications of pathogenicity", conflicting: true, stars: 1 })), "AD", 0.001).level).toBe("not-a-concern");
    expect(verifyClinical(finding("AG", rec({ classification: "Benign", stars: 2 })), "AD", 0.001).level).toBe("not-a-concern");
    expect(verifyClinical(finding("AG", rec({ stars: 1, reviewStatus: "criteria provided, single submitter" })), "AD", 0.001).level).toBe("not-a-concern");
  });
  it("separates carriers from people who could be affected", () => {
    expect(verifyClinical(finding("AG"), "AR", 0.002).level).toBe("carrier");
    expect(verifyClinical(finding("GG"), "AR", 0.002).level).toBe("alarm");
    expect(verifyClinical(finding("AG"), "XLR", 0.002).level).toBe("carrier");
    expect(verifyClinical(finding("G"), "XLR", 0.002).level).toBe("alarm"); // single-copy (hemizygous)
  });
  it("does not alarm on one copy when inheritance is unknown, but still raises two copies", () => {
    const v = verifyClinical(finding("AG"), null, 0.001);
    expect(v.checks[4].status).toBe("unknown");
    expect(v.level).toBe("unclear");
    expect(verifyClinical(finding("GG"), null, 0.001).level).toBe("alarm");
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
    const v = verifyClinical(f, "AD", 0);
    expect(v.level).toBe("not-a-concern");
    expect(v.reason).toMatch(/probably a different variant/);
  });
  it("links by position only on the forward strand", () => {
    const g = parseGenotypeText(file23([["i9", "3", 700, "CC"]]), new Set(), { fullTable: true });
    expect(linkByPosition(g, [{ rsid: "rs700", chrom: "3", pos: 700, alleles: ["A", "G"] }])).toBe(0);
  });
});

describe("frequency and inheritance sources", () => {
  it("works out the disease allele's own frequency", () => {
    expect(altFrequency(["G", 0.004, "A/G"], "A", "G")).toBe(0.004);
    expect(altFrequency(["A", 0.1, "A/G"], "A", "G")).toBeCloseTo(0.9); // the disease allele is the common one
    expect(altFrequency(["T", 0.1, "A/G/T"], "A", "G")).toBeNull(); // multi-allelic: unknown
    expect(altFrequency(undefined, "A", "G")).toBeNull();
    expect(altFrequency(["", 0, "A/G"], "A", "G")).toBe(0); // known to Ensembl, never seen in 1000 Genomes
    expect(verifyClinical(finding("AG"), "AD", 0).checks[3].detail).toMatch(/Not seen in 1000 Genomes/);
  });
  it("reads inheritance from GeneReviews text only when unambiguous", () => {
    expect(moiFromText("HFE HC is inherited in an autosomal recessive manner.")).toBe("AR");
    expect(moiFromText("Inherited in an autosomal dominant or autosomal recessive manner.")).toBeNull();
  });
  it("labels a reviewed-but-benign result calmly and hides it by default", () => {
    const item = confirmItem(finding("GG"), true, null, [], { rs700: ["A", 0.2, "A/G"] }); // G is 80% frequent
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
    const v = verifyClinical(indel("DD"), "AD", 0);
    expect(v.level).toBe("not-a-concern");
    expect(v.checks[1].status).toBe("fail");
    expect(v.checks[1].detail).toMatch(/I \(the longer version\) and D \(the shorter version\).*almost certainly means you have the normal version on both copies/);
  });
  it("never alarms on D I, even for a dominant condition", () => {
    const v = verifyClinical(indel("DI"), "AD", 0);
    expect(v.level).toBe("unclear");
    expect(v.checks[1].detail).toMatch(/can't be confirmed from this file that you carry this exact change \(deletion of CTT\)/);
  });
  it("treats D I for a recessive condition as carrier at most", () => {
    expect(verifyClinical(indel("DI"), "AR", 0).level).toBe("carrier");
  });
  it("does not repeat the genotype explanation in the rationale", () => {
    const item = confirmItem(indel("DI"), true, null, [], {});
    expect(item.why.some((w) => /^Your genotype/.test(w))).toBe(false);
    expect(item.checks!.filter((c) => /I \(the longer version\)/.test(c.detail))).toHaveLength(1);
  });
});

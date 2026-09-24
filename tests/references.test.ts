import { describe, expect, it } from "vitest";
import { chapterFor, managementParts, topicsFor, type References } from "../src/core/refs";
import { lifestyleBlocks } from "../pipeline/bulk/references";
import { confirmItem, panelHighlights, type TraitLean } from "../src/core/plain";
import { parseGenotypeText } from "../src/core/parse";
import { matchSite } from "../src/core/match";
import { clinicalFinding } from "../src/core/interpret";
import { BUNDLE, file23, site } from "./fixtures";
import type { ClinVarRecord, VerifiedWarning } from "../src/core/types";

const REFS: References = {
  retrievedAt: "t",
  genereviews: {
    chapters: [
      { pmid: "1", nbk: "NBK1", title: "BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer", url: "u1",
        clinical: "HBOC is characterized by an increased risk for breast and ovarian cancer. Second sentence. Third sentence. Fourth.",
        management: "Treatment of manifestations: Treatment per oncologist. Prevention of primary manifestations: Risk-reducing options. Surveillance: Annual MRI.",
        counseling: "Inherited in an autosomal dominant manner. Each child has a 50% chance. Third." },
      { pmid: "2", nbk: "NBK2", title: "Fanconi Anemia", url: "u2", clinical: "FA is characterized by bone marrow failure.", management: "", counseling: "" },
    ],
    genes: { BRCA1: [1, 0] },
  },
  medlineplus: {
    families: [{ id: "tg", pattern: "triglyceride", topics: ["Triglycerides"] }],
    topics: { Triglycerides: { title: "Triglycerides", url: "https://medlineplus.gov/triglycerides.html", summary: "Triglycerides are a type of fat. They come from foods.\nMore.",
      lifestyle: ["You may be able to lower your triglyceride levels with lifestyle changes:\n• Controlling your weight\n• Regular physical activity"] } },
  },
};

describe("GeneReviews lookup", () => {
  it("picks the chapter that matches the finding's condition", () => {
    expect(chapterFor(REFS, "BRCA1", ["Hereditary breast ovarian cancer syndrome"])!.nbk).toBe("NBK1");
    expect(chapterFor(REFS, "BRCA1", ["Fanconi anemia"])!.nbk).toBe("NBK2");
    expect(chapterFor(REFS, "TTN", ["x"])).toBeNull();
  });
  it("splits management at its sub-headings", () => {
    expect(managementParts(REFS.genereviews.chapters[0].management)).toEqual([
      "Treatment of manifestations: Treatment per oncologist.", "Prevention of primary manifestations: Risk-reducing options.", "Surveillance: Annual MRI.",
    ]);
  });
});

describe("MedlinePlus", () => {
  it("keeps bullet lists with the sentence that introduces them, helpful passages first", () => {
    const b = lifestyleBlocks("Factors that can raise it include:\n• Smoking\nYou may be able to lower it with lifestyle changes:\n• Regular physical activity\nUnrelated sentence.");
    expect(b[0]).toBe("You may be able to lower it with lifestyle changes:\n• Regular physical activity");
    expect(b[1]).toBe("Factors that can raise it include:\n• Smoking");
  });
  it("maps traits to topics and writes a visible 'what can help' line labelled as general advice", () => {
    expect(topicsFor(REFS, "triglyceride measurement")).toEqual(["Triglycerides"]);
    const h = panelHighlights(REFS, [{ trait: "triglyceride measurement" } as TraitLean]);
    expect(h[0]).toMatch(/^About triglycerides: Triglycerides are a type of fat/);
    expect(h[1]).toMatch(/general advice from MedlinePlus, not based on your genes\): You may be able to lower .*: Controlling your weight; Regular physical activity/);
  });
});

describe("health findings link to what can be done", () => {
  const s = site({ rsid: "rs80357906", gene: "BRCA1", chrom: "17", pos37: 100, ref: "G", alts: ["A"], domain: "clinical", label: "BRCA1 test" });
  const g = parseGenotypeText(file23([["rs80357906", "17", 100, "AG"]]), new Set(["rs80357906"]));
  const rec: ClinVarRecord = { kind: "clinvar", id: "VariationID 1", rsid: s.rsid, title: "BRCA1 c.1G>A", altAllele: "A", classification: "Pathogenic", reviewStatus: "reviewed by expert panel",
    stars: 3, conflicting: false, conditions: ["Hereditary breast ovarian cancer syndrome"], rcvs: [], lastEvaluated: null, url: "https://example.test", source: BUNDLE.clinvar[0].source };
  const f = clinicalFinding(matchSite(g, s), rec, { clingen: [] } as never);
  const warn: VerifiedWarning = { id: "snp-chip-brca", title: "t", summary: "Most BRCA chip calls were not confirmed.", quotes: [{ value: "", quote: "positive predictive value 4.2%", citation: "BMJ 2021", source: BUNDLE.clinvar[0].source }] };
  const item = confirmItem(f, true, REFS, [warn]);
  it("says what the condition is, how likely the result is real, and what specialists do if confirmed", () => {
    expect(item.highlights![0]).toMatch(/About this condition: HBOC is characterized by an increased risk/);
    expect(item.why[0]).toMatch(/How likely this is real: Most BRCA chip calls were not confirmed\. "positive predictive value 4\.2%"/);
    expect(item.more!.map((m) => m.title)).toEqual([
      "What BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer is (GeneReviews)",
      "If a clinical test confirms it: what specialists recommend (GeneReviews, management section)",
      "Family (GeneReviews, genetic counseling section)",
    ]);
    expect(item.sources.some((x) => x.label.startsWith("GeneReviews"))).toBe(true);
  });
  it("gives concrete next steps and who to talk to", () => {
    expect(item.next[0]).toMatch(/Don't make health decisions from this result alone/);
    expect(item.next.join(" ")).toMatch(/findageneticcounselor\.nsgc\.org/);
    expect(item.talkTo).toBe("a doctor or genetic counsellor");
  });
});

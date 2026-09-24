import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { buildReport } from "../src/core/interpret";
import { orSize, summarize, inheritance, actionItem, SUFFICIENT_RULES } from "../src/core/plain";
import { searchReport, matchScore } from "../src/core/search";
import { summaryMd } from "../src/core/export";
import { bulkRsids, screenClinVar, screenGwas, type BulkClinVarFile, type BulkGwasFile } from "../src/core/bulk";
import { BUNDLE, KEEP, file23 } from "./fixtures";

const CV: BulkClinVarFile = {
  version: "t", retrievedAt: "t", genes: ["BRCA1", "CFTR"], conditions: ["Hereditary breast ovarian cancer syndrome", "Cystic fibrosis"], sigs: ["Pathogenic"],
  rows: [[500, "17", 5000, "G", "A", 0, 3, 0, [0], 50, "", "NM_x(BRCA1):c.1G>A"], [501, "7", 5100, "C", "T", 0, 3, 1, [1], 51, "", "NM_y(CFTR):c.2C>T"]],
  cites: { "50": [9001] },
};
const GW: BulkGwasFile = {
  version: "t", retrievedAt: "t", traits: [["coronary artery disease", "u1", "Cardiovascular disease", "disease"]],
  sites: { rs600: ["1", 6000, "C", "T", "T", "LPA"] }, samples: ["100,000 European"],
  groups: [["rs600", 0, "T", "T", 1.6, 0, 1, "[1.5-1.7]", "1E-50", 700, 0, 4, 0, 4, [700, 701, 702, 703], "forward"]],
  studies: {}, aliases: {},
};

function report() {
  const g = parseGenotypeText(file23([
    ["rs1", "6", 100, "AG"], ["rs2", "10", 200, "TT"], ["rs6", "19", 45411941, "CT"], ["rs7", "19", 45412079, "CC"],
    ["rs500", "17", 5000, "GG"], ["rs501", "7", 5100, "CT"], ["rs600", "1", 6000, "TT"],
  ]), new Set([...KEEP, ...bulkRsids(CV, GW)]));
  const r = buildReport(g, BUNDLE);
  r.bulk = { clinvar: screenClinVar(g, CV, []), gwas: screenGwas(g, GW, new Set()) };
  return r;
}

describe("plain-language summary", () => {
  const r = report();
  const s = summarize(r, { showSensitive: false });
  const byId = (p: string) => s.items.filter((i) => i.id.startsWith(p));

  it("leads with a count headline of sufficient-evidence items only", () => {
    expect(s.headline).toMatch(/to confirm with a doctor · \d+ diet, supplement or lifestyle step/);
    const n = s.items.filter((i) => i.tone === "action" && i.sufficient).length;
    expect(s.headline).toContain(`${n} diet, supplement or lifestyle step`);
  });
  it("explains a recessive carrier in plain words, with rationale and next steps", () => {
    const c = byId("confirm-VCV-rs1")[0];
    expect(c.plain).toMatch(/carry one copy.*two copies.*carriers without symptoms/);
    expect(c.why.join(" ")).toMatch(/ClinVar classifies/);
    expect(c.next.join(" ")).toMatch(/clinical-grade genetic test/);
    expect(c.next.join(" ")).toMatch(/family planning/);
  });
  it("lists each genome-wide rare hit separately, with the false-positive caveat", () => {
    const b = s.items.find((i) => i.id === "confirm-VariationID 51")!;
    expect(b.category).toBe("health");
    expect(b.confidence).toBe("low");
    expect(b.why[0]).toMatch(/16%/);
    expect(b.title).toMatch(/CFTR/);
    expect(b.evidenceLabel).toMatch(/chip call unverified/);
    expect(b.sufficient).toBe(true); // 3★ classification; the genotype still needs confirmation
  });
  it("turns actions into plain items that say whether genes change the advice", () => {
    const a = byId("action-lifestyle")[0];
    expect(a.why.join(" ")).toMatch(/general advice/);
    expect(a.confidence).toBe("moderate"); // best evidence is an RCT
  });
  it("describes common variants as small relative effects, never diagnoses", () => {
    const k = byId("know-t2d")[0];
    expect(k.plain).toMatch(/2 copies.*slightly higher odds of type 2 diabetes\..*not a diagnosis/);
    expect(k.why.join(" ")).toMatch(/not your personal chance/);
  });
  it("surfaces well-replicated genome-wide hits with at least a moderate effect as trait items", () => {
    const h = byId("scan-rs600")[0];
    expect(h.category).toBe("trait");
    expect(h.sufficient).toBe(true);
    expect(h.plain).toMatch(/2 copies of a variant near LPA linked to moderately higher odds of coronary artery disease/);
  });
  it("applies the sufficient-evidence bar per category", () => {
    const life = byId("action-lifestyle")[0];
    expect(life.category).toBe("lifestyle");
    expect(life.sufficient).toBe(true); // RCT
    const a = r.interventions[0];
    const weakDesign = actionItem({ ...a, bestDesign: "observational" });
    expect(weakDesign.sufficient).toBe(false);
    const noLimit = actionItem({ ...a, bestDesign: "meta-analysis", intervention: { ...a.intervention, type: "supplement", safety: null } });
    expect(noLimit.category).toBe("supplement");
    expect(noLimit.sufficient).toBe(false); // supplements also need a verified upper limit
    expect(Object.keys(SUFFICIENT_RULES)).toContain("medication");
  });
  it("hides sensitive items unless opted in", () => {
    expect(s.items.some((i) => i.id === "know-apoe")).toBe(false);
    expect(summarize(r, { showSensitive: true }).items.some((i) => i.id === "know-apoe")).toBe(true);
  });
  it("exports the summary first in Markdown", () => {
    const md = summaryMd(s);
    expect(md.startsWith("# Summary")).toBe(true);
    expect(md).toMatch(/\*\*What you could do:\*\*/);
  });
  it("uses a fixed odds-ratio size rubric", () => {
    expect([orSize(1.05), orSize(1.2), orSize(0.6), orSize(3.5)]).toEqual(["very small", "small", "moderate", "large"]);
  });
  it("only states an inheritance pattern when ClinGen is unambiguous", () => {
    const f = r.clinical.find((c) => c.record.rsid === "rs1")!;
    expect(inheritance(f)).toBe("AR");
    expect(inheritance({ ...f, clingen: [...f.clingen, { ...f.clingen[0], moi: "AD", disease: "other" }], record: { ...f.record, conditions: ["unrelated"] } })).toBeNull();
    // Condition-specific: the same gene can be AD for one condition and AR for another.
    const mixed = { ...f, clingen: [{ ...f.clingen[0], disease: "thrombophilia", moi: "AD" }, { ...f.clingen[0], disease: "congenital factor v deficiency", moi: "AR" }] };
    expect(inheritance(mixed, "Thrombophilia")).toBe("AD");
    expect(inheritance(mixed, "Factor V deficiency")).toBe("AR");
  });
});

describe("search", () => {
  const r = report();
  const s = summarize(r, { showSensitive: false });
  const find = (q: string) => searchReport(r, s, q, { showSensitive: false });

  it("answers 'was this gene tested?' from the genome-wide screen", () => {
    const h = find("BRCA1").find((x) => x.title === "BRCA1: coverage")!;
    expect(h.plain).toMatch(/1 known disease-causing BRCA1 variant was readable.*none flagged.*does not rule anything out/);
  });
  it("finds flagged variants and conditions", () => {
    expect(find("cystic fibrosis").some((h) => h.group === "Rare disease variants" && /Flagged/.test(h.plain))).toBe(true);
  });
  it("groups trait associations and links to the explorer", () => {
    const h = find("coronary").find((x) => x.group === "Trait associations")!;
    expect(h.plain).toMatch(/1 variant in your file is linked to coronary artery disease/);
    expect(h.target).toEqual({ tab: "appendix", section: "explorer", query: "coronary artery disease" });
  });
  it("finds curated sites by rsID and says when a gene has nothing on the chip", () => {
    expect(find("rs2")[0].title).toMatch(/rs2/);
    expect(find("TTN").some((h) => /No known disease-causing TTN variants/.test(h.plain))).toBe(true);
  });
  it("respects the sensitive-results setting", () => {
    expect(find("APOE").length).toBe(0);
  });
  it("scores exact > prefix > word > substring", () => {
    expect([matchScore("brca1", "BRCA1"), matchScore("brca", "BRCA1"), matchScore("fibrosis", "cystic fibrosis"), matchScore("ibros", "cystic fibrosis")]).toEqual([100, 80, 60, 40]);
  });
});

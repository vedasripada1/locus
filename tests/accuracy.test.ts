import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { matchSite, describeAllele, readableGenotype } from "../src/core/match";
import { linkByPosition, newAudit, recordAudit, auditSummary } from "../src/core/audit";
import { summarize, PANELS, traitLean, leanLine, plainTrait } from "../src/core/plain";
import { buildReport } from "../src/core/interpret";
import { parseInteraction } from "../pipeline/bulk/nutrigenomics";
import { BUNDLE, KEEP, SITES, file23, site } from "./fixtures";
import type { BulkGwasHit } from "../src/core/bulk";

const S = (id: string) => SITES.find((s) => s.rsid === id)!;

describe("whole-file table and position linking", () => {
  it("keeps every row of the file as a table", () => {
    const g = parseGenotypeText(file23([["rs2", "10", 200, "TT"], ["i4000377", "13", 5000, "DI"]], { filler: 5 }), KEEP, { fullTable: true });
    expect(g.table!.id.length).toBe(7);
    expect(g.table!.geno[g.table!.id.indexOf("i4000377")]).toBe("DI");
  });
  it("links an internal i-ID to an evidence site by chromosome, position and alleles", () => {
    const g = parseGenotypeText(file23([["i7000001", "6", 100, "AG"]]), KEEP, { fullTable: true });
    expect(g.calls.has("rs1")).toBe(false);
    expect(linkByPosition(g, [{ rsid: "rs1", chrom: "6", pos: 100, alleles: ["G", "A"] }])).toBe(1);
    const m = matchSite(g, S("rs1"));
    expect(m.status).toBe("matched");
    expect(m.call!.matchedBy).toBe("position");
    expect(m.notes.join(" ")).toMatch(/Matched by chromosome and position: your file lists this site as i7000001/);
  });
  it("refuses a position link when the alleles don't fit, or the build isn't GRCh37", () => {
    const g = parseGenotypeText(file23([["i7000001", "6", 100, "AC"]]), KEEP, { fullTable: true });
    expect(linkByPosition(g, [{ rsid: "rs1", chrom: "6", pos: 100, alleles: ["A", "G"] }])).toBe(0); // AC fits neither A/G nor its complement (TG)
  });
  it("never links indel rows by position", () => {
    const g = parseGenotypeText(file23([["i5", "7", 400, "DI"]]), KEEP, { fullTable: true });
    expect(linkByPosition(g, [{ rsid: "rs4", chrom: "7", pos: 400, alleles: ["CTT", "C"] }])).toBe(0);
  });
  it("does not link by position on other builds", () => {
    const g = parseGenotypeText(file23([["i7000001", "6", 100, "AG"]], { build: "build 36" }), KEEP, { fullTable: true });
    expect(linkByPosition(g, [{ rsid: "rs1", chrom: "6", pos: 100, alleles: ["G", "A"] }])).toBe(0);
  });
});

describe("plain-language genotypes", () => {
  const g = parseGenotypeText(file23([["rs4", "7", 400, "DI"], ["rs1", "6", 100, "AG"], ["rs2", "10", 200, "AG"]]), KEEP);
  it("explains I/D codes as the actual DNA change", () => {
    const t = readableGenotype(matchSite(g, S("rs4")));
    expect(t).toMatch(/I = the longer version, D = the shorter version/);
    expect(t).toMatch(/One copy of each version\. It can't be confirmed from the file whether either is the deletion of CTT/);
  });
  it("describes SNV and strand-flipped genotypes", () => {
    expect(readableGenotype(matchSite(g, S("rs1")))).toBe("AG: one A and one G.");
    expect(readableGenotype(matchSite(g, S("rs2")))).toMatch(/opposite DNA strand: AG/);
  });
  it("describes deletion and insertion alleles", () => {
    expect(describeAllele(site({ rsid: "x", kind: "deletion", ref: "ACTT", alts: ["A"] }), "A")).toBe("deletion of CTT");
    expect(describeAllele(site({ rsid: "x", kind: "insertion", ref: "G", alts: ["GC"] }), "GC")).toBe("insertion of C");
    expect(describeAllele(site({ rsid: "x", kind: "deletion", ref: "T", alts: ["-"] }), "-")).toBe("deletion of T");
  });
});

describe("accuracy audit", () => {
  it("counts how each site was linked and checked, with examples of problems", () => {
    const g = parseGenotypeText(file23([["rs2", "10", 999, "TT"], ["rs1", "6", 100, "CT"], ["rs3", "2", 300, "AT"], ["rs9", "3", 900, "--"]]), KEEP, { fullTable: true });
    const a = newAudit(g.table!.id.length);
    for (const id of ["rs2", "rs1", "rs3", "rs9", "rs11"]) recordAudit(a, matchSite(g, S(id)));
    const s = auditSummary(a);
    expect(s).toMatchObject({ sites: 4, byRsid: 4, posMismatch: 1, forward: 1, complemented: 1, palindromic: 1, noCall: 1 });
    expect(s.examples[0]).toMatchObject({ kind: "position", fileId: "rs2" });
    expect(s.fileIds.sort()).toEqual(["rs1", "rs2", "rs3", "rs9"]);
  });
});

describe("trait panels and leans", () => {
  let n = 0;
  const hit = (p: Partial<BulkGwasHit>): BulkGwasHit => ({
    rsid: `rs${++n}`, gene: "GENE", trait: "C-reactive protein measurement", traitUri: "crp", categories: "", domain: "metabolism", genotype: "CT", forwardGenotype: "CT", orientation: "forward",
    effectAllele: "T", effectForward: "T", copies: 2, value: 0.1, kind: "beta", direction: "increase", ci: "", p: "1E-50", leadPmid: 1, sample: "", concordantPubs: 5, discordant: 0, nAssocs: 5, pmids: [1],
    strength: "strong", notes: [], frequency: 0.3, chrom: "1", pos: n * 1_000_000, traitDefinition: "A measure of inflammation.", ...p,
  });

  it("compares your copies with a typical person's (2 × allele frequency)", () => {
    // 2 copies vs typical 0.6 of a raising allele → higher; 0 copies vs 0.6 → lower; 1 copy vs 1.0 (freq .5) → typical.
    const l = traitLean([hit({}), hit({}), hit({}), hit({ copies: 0 }), hit({ copies: 1, frequency: 0.5 })]);
    expect(l).toMatchObject({ n: 5, higher: 3, lower: 1, typical: 1, lean: "higher", phrase: "C-reactive protein" });
    expect(leanLine(l)).toMatch(/C-reactive protein: leans slightly higher\. Of 5 independent variants, 3 point higher than typical, 1 lower, 1 about typical/);
  });
  it("counts linked variants (within 500 kb) once and skips variants without a frequency", () => {
    const l = traitLean([hit({ pos: 1_000 }), hit({ pos: 200_000 }), hit({ pos: 3_000_000 }), hit({ frequency: null })]);
    expect(l.n).toBe(2);
  });
  it("treats a lowering allele the other way round, and reports no lean without a clear margin", () => {
    const lower = traitLean([hit({ direction: "decrease" }), hit({ direction: "decrease" }), hit({ direction: "decrease" })]);
    expect(lower.lean).toBe("lower");
    expect(traitLean([hit({}), hit({}), hit({ copies: 0 }), hit({ copies: 0 })]).lean).toBe("none");
    expect(traitLean([hit({}), hit({})]).lean).toBe("none"); // fewer than 3 variants
  });
  it("disease traits read as odds", () => {
    expect(plainTrait("asthma", "OR")).toBe("odds of asthma");
  });
  it("panel cards lead with a plain bottom line, per-trait leans, definitions and caveats", () => {
    const g = parseGenotypeText(file23([["rs2", "10", 200, "TT"]]), KEEP);
    const r = buildReport(g, BUNDLE);
    r.bulk = { clinvar: { version: "", tested: 0, notCarried: 0, noCall: 0, carried: [], cites: {}, byGene: {}, byCondition: {} },
      gwas: { version: "", tested: 4, studies: {}, hits: [hit({}), hit({}), hit({}), hit({ trait: "asthma", kind: "OR", value: 1.2, copies: 1 })] } };
    const p = summarize(r, { showSensitive: false }).items.find((i) => i.id === "panel-immune")!;
    expect(p.plain).toMatch(/lean slightly towards higher C-reactive protein\./);
    expect(p.plain).toMatch(/Too few independent variants to judge: odds of asthma/);
    expect(p.plain).not.toMatch(/other 0/);
    expect(p.more![1].lines[0]).toMatch(/you have 2 copies of T \(a typical person has about 0\.6\)/);
    expect(p.list![0]).toMatch(/^C-reactive protein: leans slightly higher/);
    expect(p.why.join(" ")).toMatch(/isn't a validated risk score/);
    expect(p.next.join(" ")).toMatch(/doesn't show that you have, or will get, a condition/);
    expect(p.more![0].lines[0]).toMatch(/A measure of inflammation/);
    expect(PANELS.length).toBeGreaterThan(10);
  });
  it("panel patterns match whole words (polyunsaturated is not urate)", () => {
    const kidney = PANELS.find((x) => x.id === "kidney")!.pattern;
    expect(kidney.test("omega-3 polyunsaturated fatty acid measurement")).toBe(false);
    expect(kidney.test("urate measurement")).toBe(true);
  });
});

describe("CTD nutrient–gene parsing", () => {
  it("keeps only simple, direct expression statements", () => {
    expect(parseInteraction("Folic Acid", "MTHFR", "Folic Acid results in increased expression of MTHFR mRNA")).toBe(1);
    expect(parseInteraction("Quercetin", "TCF7L2", "Quercetin results in decreased expression of TCF7L2 protein")).toBe(-1);
    expect(parseInteraction("Resveratrol", "AR", "Resveratrol affects the reaction [MYC protein results in increased expression of AR protein]")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { matchSite, describeAllele, readableGenotype } from "../src/core/match";
import { linkByPosition, newAudit, recordAudit, auditSummary } from "../src/core/audit";
import { summarize, PANELS } from "../src/core/plain";
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
    expect(t).toMatch(/I = insertion, D = deletion/);
    expect(t).toMatch(/One copy has the deletion of CTT; the other doesn't/);
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

describe("trait panels", () => {
  it("lists well-replicated carried variants per panel without scoring them", () => {
    const g = parseGenotypeText(file23([["rs2", "10", 200, "TT"]]), KEEP);
    const r = buildReport(g, BUNDLE);
    const hit = (trait: string, copies: number, strength: BulkGwasHit["strength"] = "strong"): BulkGwasHit => ({
      rsid: `rs${trait.length}${copies}`, gene: "APOB", trait, traitUri: trait, categories: "", domain: "metabolism", genotype: "CT", forwardGenotype: "CT", orientation: "forward",
      effectAllele: "T", effectForward: "T", copies, value: 0.1, kind: "beta", direction: "increase", ci: "", p: "1E-50", leadPmid: 1, sample: "", concordantPubs: 5, discordant: 0, nAssocs: 5, pmids: [1], strength, notes: [],
    });
    r.bulk = { clinvar: { version: "", tested: 0, notCarried: 0, noCall: 0, carried: [], cites: {}, byGene: {}, byCondition: {} },
      gwas: { version: "", tested: 3, studies: {}, hits: [hit("low density lipoprotein cholesterol measurement", 1), hit("triglyceride measurement", 0), hit("high density lipoprotein cholesterol measurement", 2, "moderate")] } };
    const p = summarize(r, { showSensitive: false }).items.find((i) => i.id === "panel-lipids")!;
    expect(p.list).toHaveLength(1); // not carried and not-strong are excluded
    expect(p.list![0]).toMatch(/APOB .*1 copy of T, linked to higher low density lipoprotein cholesterol measurement/);
    expect(p.plain).toMatch(/not added into a score/);
    expect(PANELS.length).toBeGreaterThan(10);
  });
});

describe("CTD nutrient–gene parsing", () => {
  it("keeps only simple, direct expression statements", () => {
    expect(parseInteraction("Folic Acid", "MTHFR", "Folic Acid results in increased expression of MTHFR mRNA")).toBe(1);
    expect(parseInteraction("Quercetin", "TCF7L2", "Quercetin results in decreased expression of TCF7L2 protein")).toBe(-1);
    expect(parseInteraction("Resveratrol", "AR", "Resveratrol affects the reaction [MYC protein results in increased expression of AR protein]")).toBeNull();
  });
});

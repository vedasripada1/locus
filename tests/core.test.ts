import { describe, expect, it } from "vitest";
import { parseGenotypeText, ParseError } from "../src/core/parse";
import { matchSite, isPalindromic, orientAllele } from "../src/core/match";
import { buildReport, gwasFinding, apoeFinding, classifyClinVar, EMPTY_CONTEXT } from "../src/core/interpret";
import { toJson, toMarkdown } from "../src/core/export";
import { verifyQuoted, buildInterventions } from "../pipeline/build";
import { BUNDLE, CLINVAR, KEEP, SITES, TOPICS, GWAS, file23, fileAnc, gw } from "./fixtures";
import type { AuditEntry } from "../src/core/types";

const S = (id: string) => SITES.find((s) => s.rsid === id)!;
const standard23 = () =>
  parseGenotypeText(
    file23([
      ["rs1", "6", 100, "AG"], // pathogenic heterozygote
      ["rs2", "10", 200, "TT"],
      ["rs3", "2", 300, "AT"], // palindromic
      ["rs4", "7", 400, "DI"], // deletion heterozygote
      ["rs55", "1", 500, "GG"], // merged rsID
      ["rs6", "19", 45411941, "CT"],
      ["rs7", "19", 45412079, "CC"],
      ["rs8", "X", 800, "A"], // hemizygous
      ["rs9", "3", 900, "--"], // no-call
      ["rs10", "4", 1000, "AG"], // conflicting ClinVar
    ]),
    KEEP,
  );

describe("parsing", () => {
  it("reads 23andMe: format, build, genotypes, no-calls, indels, hemizygous calls", () => {
    const g = standard23();
    expect(g.format).toBe("23andme");
    expect(g.build).toBe("GRCh37");
    expect(g.calls.get("rs1")!.alleles).toEqual(["A", "G"]);
    expect(g.calls.get("rs9")!.alleles).toEqual([]);
    expect(g.calls.get("rs4")!.alleles).toEqual(["D", "I"]);
    expect(g.calls.get("rs8")!.alleles).toEqual(["A"]);
    expect(g.stats.noCallRows).toBe(1);
    expect(g.calls.has("rs900000")).toBe(false); // filler is counted but not retained
    expect(g.stats.totalRows).toBe(60);
  });

  it("reads AncestryDNA: numeric chromosomes, CRLF, 0 as no-call", () => {
    const g = parseGenotypeText(fileAnc([["rs1", "6", 100, "G", "G"], ["rs8", "23", 800, "A", "A"], ["rs2", "10", 200, "0", "0"]]), KEEP);
    expect(g.format).toBe("ancestrydna");
    expect(g.build).toBe("GRCh37");
    expect(g.calls.get("rs8")!.chrom).toBe("X");
    expect(g.calls.get("rs2")!.alleles).toEqual([]);
    expect(g.calls.get("rs1")!.raw).toBe("G G");
  });

  it("rejects VCF, CSV exports, empty and corrupted files with clear messages", () => {
    expect(() => parseGenotypeText("##fileformat=VCFv4.2\n#CHROM\tPOS\n1\t2\n", KEEP)).toThrow(/VCF/);
    expect(() => parseGenotypeText("RSID,CHROMOSOME,POSITION,RESULT\nrs1,1,2,AA\n", KEEP)).toThrow(/comma-separated/);
    expect(() => parseGenotypeText("# only comments\n", KEEP)).toThrow(ParseError);
    const broken = file23([], { filler: 10 }) + Array.from({ length: 5 }, () => "garbage line").join("\n");
    expect(() => parseGenotypeText(broken, KEEP)).toThrow(/could not be read/);
  });

  it("warns on low call rate, unknown build, and discordant duplicates", () => {
    const rows: [string, string, number, string][] = Array.from({ length: 20 }, (_, i) => [`rs7${i}`, "1", i, "--"]);
    const txt = file23([...rows, ["rs2", "10", 200, "TT"], ["rs2", "10", 200, "CC"]], { build: "an unstated build" });
    const g = parseGenotypeText(txt, KEEP);
    const codes = g.issues.map((i) => i.code);
    expect(codes).toContain("low-call-rate");
    expect(codes).toContain("build");
    expect(codes).toContain("duplicates");
    expect(g.calls.get("rs2")!.alleles).toEqual([]); // discordant duplicate → treated as no-call
  });
});

describe("allele matching", () => {
  const g = standard23();
  it("matches forward-strand genotypes and checks position", () => {
    const m = matchSite(g, S("rs2"));
    expect(m.status).toBe("matched");
    expect(m.orientation).toBe("forward");
    expect(m.positionCheck).toBe("ok");
  });
  it("complements opposite-strand calls at non-palindromic sites", () => {
    const g2 = parseGenotypeText(file23([["rs2", "10", 200, "AG"]]), KEEP); // A/G = complement of T/C
    const m = matchSite(g2, S("rs2"));
    expect(m.orientation).toBe("complemented");
    expect(m.forwardAlleles).toEqual(["T", "C"]);
  });
  it("flags palindromic sites instead of silently trusting them", () => {
    expect(isPalindromic(S("rs3"))).toBe(true);
    const m = matchSite(g, S("rs3"));
    expect(m.orientation).toBe("ambiguous-palindromic");
    expect(orientAllele("T", S("rs3")).how).toBe("ambiguous");
  });
  it("judges strand ambiguity on the main allele pair, not every dbSNP allele", () => {
    expect(isPalindromic(S("rs12"))).toBe(false); // C>A,G,T but the real pair is C/T
    expect(orientAllele("T", S("rs12")).how).toBe("forward");
  });
  it("rejects alleles that fit neither strand", () => {
    const g2 = parseGenotypeText(file23([["rs1", "6", 100, "CT"]]), KEEP); // site is G/A; complement C/T fits, so use a truly wrong one
    expect(matchSite(g2, S("rs1")).orientation).toBe("complemented");
    const g3 = parseGenotypeText(file23([["rs2", "10", 200, "AC"]]), KEEP); // C/T site: A fits only complemented, C only forward
    expect(matchSite(g3, S("rs2")).status).toBe("allele-mismatch");
  });
  it("maps I/D calls onto deletion alleles", () => {
    const m = matchSite(g, S("rs4"));
    expect(m.orientation).toBe("indel-coded");
    expect(m.forwardAlleles.sort()).toEqual(["-", "CTT"]);
  });
  it("resolves merged rsIDs and records the alias", () => {
    const m = matchSite(g, S("rs5"));
    expect(m.status).toBe("matched");
    expect(m.notes.join(" ")).toMatch(/merged rsID rs55/);
  });
  it("never treats a missing variant or a no-call as negative", () => {
    const missing = matchSite(g, S("rs11"));
    expect(missing.status).toBe("not-on-array");
    expect(missing.notes.join(" ")).toMatch(/not a negative result/);
    const nocall = matchSite(g, S("rs9"));
    expect(nocall.status).toBe("no-call");
    expect(nocall.forwardAlleles).toEqual([]);
  });
  it("flags position mismatches", () => {
    const g2 = parseGenotypeText(file23([["rs2", "10", 999, "TT"]]), KEEP);
    expect(matchSite(g2, S("rs2")).positionCheck).toBe("mismatch");
  });
});

describe("interpretation", () => {
  const g = standard23();
  const report = buildReport(g, BUNDLE);

  it("puts carried pathogenic variants first, with confirmation and AR carrier wording", () => {
    const f = report.clinical.find((c) => c.record.rsid === "rs1")!;
    expect(f.category).toBe("pathogenic-carried");
    expect(f.zygosity).toBe("heterozygous");
    expect(f.headline).toMatch(/confirmation/);
    expect(f.headline).toMatch(/autosomal recessive/);
  });
  it("keeps conflicting ClinVar interpretations out of the actionable group", () => {
    const f = report.clinical.find((c) => c.record.rsid === "rs10")!;
    expect(f.category).toBe("conflicting");
    expect(f.headline).toMatch(/disagree/);
  });
  it("uses per-condition ClinVar classifications only with adequate review status", () => {
    const base = { ...CLINVAR[0], classification: "drug response" };
    const rcv = (classification: string, stars: 0 | 1 | 2 | 3 | 4) => ({ rcv: "RCV1.1", condition: "Thrombophilia", classification, reviewStatus: "", stars });
    expect(classifyClinVar({ ...base, rcvs: [rcv("Pathogenic", 2)] })).toEqual({ kind: "pathogenic", conditions: ["Thrombophilia"] });
    expect(classifyClinVar({ ...base, rcvs: [rcv("Pathogenic", 1)] }).kind).toBe("annotation");
    expect(classifyClinVar({ ...base, rcvs: [rcv("Conflicting classifications of pathogenicity", 1)] }).kind).toBe("conflicting");
    expect(classifyClinVar({ ...base, conflicting: true, rcvs: [rcv("Pathogenic", 3)] }).kind).toBe("conflicting");
  });
  it("orients GWAS effect alleles across strands and reported alleles", () => {
    const f = report.disease.find((x) => x.kind === "gwas" && x.topic.id === "t2d");
    expect(f?.kind).toBe("gwas");
    if (f?.kind !== "gwas") return;
    expect(f.effectAlleleForward).toBe("T");
    expect(f.effectCopies).toBe(2);
    expect(f.consistency).toEqual({ concordant: 3, discordant: 0, studies: 3 });
    expect(f.strength).toBe("strong");
    expect(f.headline).toMatch(/higher odds of type 2 diabetes/);
    expect(f.headline).not.toMatch(/%|absolute|will develop/i);
  });
  it("flags contradictory GWAS directions as conflicting", () => {
    const assocs = [gw({ rsid: "rs2", effectAllele: "T", traitLabel: "Type 2 diabetes", orValue: 1.2 }), gw({ rsid: "rs2", effectAllele: "T", traitLabel: "Type 2 diabetes", orValue: 0.8 })];
    const f = gwasFinding(TOPICS[0], matchSite(g, S("rs2")), assocs);
    expect(f.strength).toBe("conflicting");
  });
  it("picks the lead from the majority direction, so one mis-oriented study cannot flip the headline", () => {
    const assocs = [
      gw({ rsid: "rs2", effectAllele: "C", traitLabel: "Type 2 diabetes", orValue: 3.1 }), // outlier: other allele, risk-increasing
      ...[1.3, 1.25, 1.4].map((o) => gw({ rsid: "rs2", effectAllele: "T", traitLabel: "Type 2 diabetes", orValue: o })),
    ];
    const f = gwasFinding(TOPICS[0], matchSite(g, S("rs2")), assocs);
    expect(f.lead.effectAllele).toBe("T");
    expect(f.consistency).toMatchObject({ concordant: 3, discordant: 1 });
    expect(f.strength).toBe("conflicting");
    expect(f.headline).toMatch(/Studies disagree/);
  });
  it("orients a study allele that only matches a rare third allele as the main pair on the other strand", () => {
    expect(orientAllele("A", S("rs12"))).toEqual({ allele: "T", how: "complemented" }); // site C>A,G,T; main pair C/T
  });
  it("does not count effect alleles at palindromic sites", () => {
    const f = gwasFinding(TOPICS[1], matchSite(g, S("rs3")), GWAS.filter((a) => a.rsid === "rs3"));
    expect(f.effectCopies).toBeNull();
    expect(f.limitations.join(" ")).toMatch(/Palindromic/);
  });
  it("derives APOE type and states unphased ambiguity", () => {
    expect(apoeFinding(TOPICS[2], matchSite(g, S("rs6")), matchSite(g, S("rs7"))).result).toBe("ε3/ε4");
    const g2 = parseGenotypeText(file23([["rs6", "19", 45411941, "CT"], ["rs7", "19", 45412079, "CT"]]), KEEP);
    const f = apoeFinding(TOPICS[2], matchSite(g2, S("rs6")), matchSite(g2, S("rs7")));
    expect(f.result).toBe("ε2/ε4");
    expect(f.ambiguity).toMatch(/ε1\/ε3/);
  });
  it("reports tested topics without evidence, and untested topics as untested", () => {
    const perf = report.performance.find((f) => f.kind === "no-evidence")!;
    expect(perf.headline).toMatch(/None of these variants were tested|no genome-wide significant/);
    const untested = report.metabolism.find((f) => f.kind === "no-evidence" && f.topic.id === "untested")!;
    expect(untested.headline).toMatch(/None of these variants were tested/);
  });
  it("triggers interventions from findings, applies context, and never claims genotype specificity without evidence", () => {
    const r = buildReport(g, BUNDLE, { ...EMPTY_CONTEXT, medications: "Metformin 500mg" });
    const life = r.interventions.find((a) => a.intervention.id === "lifestyle")!;
    expect(life.genotypeSpecific).toBe("not-established");
    expect(life.contextWarnings).toEqual(["MED FLAG"]);
    expect(r.interventions.some((a) => a.intervention.id === "carrier-action")).toBe(true);
  });
  it("allows 'no evidence-based personalized action'", () => {
    const g2 = parseGenotypeText(file23([["rs2", "10", 200, "CC"], ["rs1", "6", 100, "GG"]]), KEEP);
    const r = buildReport(g2, BUNDLE);
    expect(r.interventions).toEqual([]);
    expect(r.topicsWithoutAction).toContain("Type 2 diabetes");
    expect(toMarkdown(r, BUNDLE, { showSensitive: false })).toMatch(/No evidence-based personalized action/);
  });
  it("hides sensitive findings unless opted in, and exports never contain the raw file", () => {
    const md = toMarkdown(report, BUNDLE, { showSensitive: false });
    expect(md).not.toMatch(/APOE type/);
    expect(toMarkdown(report, BUNDLE, { showSensitive: true })).toMatch(/APOE type ε3\/ε4/);
    expect(toJson(report)).not.toMatch(/rs900000/);
    const full = parseGenotypeText(file23([["rs2", "10", 200, "TT"]]), KEEP, { fullTable: true });
    expect(full.table!.id).toContain("rs9000000"); // the table holds every row...
    const withTable = { ...report, table: full.table, audit: { fileIds: ["rs2"] } as never };
    expect(toJson(withTable)).not.toMatch(/rs9000000|"fileIds"/); // ...but exports never do
  });
});

describe("evidence verification (pipeline)", () => {
  const text = "RESULTS: We identified eight trials (n=9563). Supplementation did not reduce events.";
  it("accepts verbatim quotes and rejects fabricated or altered ones", () => {
    expect(verifyQuoted({ value: "9563", quote: "eight trials (n=9563)" }, text)).toBeNull();
    expect(verifyQuoted({ value: "9563", quote: "eight trials (n = 10000)" }, text)).toMatch(/not found/);
    expect(verifyQuoted({ value: "12000", quote: "eight trials (n=9563)" }, text)).toMatch(/numbers not in its quote/);
  });
  it("drops unverifiable claims and supplements without direct human evidence", () => {
    const audit: AuditEntry[] = [];
    const texts = new Map([
      ["pmid:1", { key: "pmid:1", kind: "pmid" as const, title: "Obs study", text: "In mice, compound X reduced weight.",
        record: { pmid: "1", title: "Obs", abstract: "In mice, compound X reduced weight.", journal: "J", year: "2020", doi: null, firstAuthor: "A",
          publicationTypes: ["Journal Article"], mesh: ["Animals", "Mice"], book: false, source: { source: "PubMed" as const, version: "", retrievedAt: "", url: "" } },
        source: { source: "PubMed" as const, version: "", retrievedAt: "", url: "" } }],
    ]);
    const seed = [
      { id: "fabricated", type: "food", triggers: [], studies: [{ ref: { pmid: "1" }, role: "general", genotypeInteraction: "not-tested", sampleSize: null, population: null, exposure: null, harms: null,
        outcomes: [{ value: "Lowers weight in humans", quote: "reduced weight in humans" }] }], safety: null, limitations: [], contextFlags: [] },
      { id: "animal-supplement", type: "supplement", triggers: [], studies: [{ ref: { pmid: "1" }, role: "general", genotypeInteraction: "not-tested", sampleSize: null, population: null, exposure: null, harms: null,
        outcomes: [{ value: "Reduced weight", quote: "compound X reduced weight" }] }], safety: null, limitations: [], contextFlags: [] },
      { id: "missing-source", type: "food", triggers: [], studies: [{ ref: { pmid: "999" }, role: "general", genotypeInteraction: "not-tested", sampleSize: null, population: null, exposure: null, harms: null, outcomes: [] }], safety: null, limitations: [], contextFlags: [] },
    ];
    const out = buildInterventions(seed, texts as any, audit);
    expect(out).toEqual([]);
    const dropped = audit.filter((a) => a.outcome === "dropped").map((a) => a.subject + ": " + a.detail).join("\n");
    expect(dropped).toMatch(/fabricated.*quote not found/);
    expect(dropped).toMatch(/animal-supplement: Supplement excluded: no verified human RCT/);
    expect(dropped).toMatch(/missing-source.*could not be retrieved/);
  });
});

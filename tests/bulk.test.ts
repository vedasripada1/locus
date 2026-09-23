import { describe, expect, it } from "vitest";
import { parseGenotypeText } from "../src/core/parse";
import { bulkRsids, screenClinVar, screenGwas, strengthOf, type BulkClinVarFile, type BulkGwasFile } from "../src/core/bulk";
import { toCsv } from "../src/ui/Bulk";
import { keepRow, starsFor } from "../pipeline/bulk/clinvar";
import { domainFor, effectKind, mainAltFor, orient } from "../pipeline/bulk/gwas";
import { file23 } from "./fixtures";

// Synthetic bulk files (no real person's data).
const CV: BulkClinVarFile = {
  version: "2026-01-01", retrievedAt: "2026-01-01", genes: ["GENEA", "GENEB", "GENEC"], conditions: ["Condition A", "Condition B"],
  sigs: ["Pathogenic", "Likely pathogenic"],
  rows: [
    [100, "1", 1000, "G", "A", 0, 2, 0, [0], 11, "", "NM_1(GENEA):c.1G>A (p.X)"], // het carried
    [101, "1", 1100, "C", "T", 1, 1, 1, [1], 12, "", "NM_2(GENEB):c.2C>T"], // not carried
    [102, "2", 1200, "ACTT", "A", 0, 3, 2, [0], 13, "", "NM_3(GENEC):c.3del"], // deletion, carried via I/D
    [103, "2", 1300, "G", "T", 0, 2, 0, [], 14, "", "NM_4(GENEA):c.4G>T"], // no-call
    [104, "3", 1400, "G", "C", 0, 1, 0, [], 15, "", "NM_5(GENEA):c.5G>C"], // not on chip
  ],
  cites: { "11": [111, 222], "13": [333] },
};
const GW: BulkGwasFile = {
  version: "2026-01-01", retrievedAt: "2026-01-01",
  traits: [["type 2 diabetes mellitus", "http://x/MONDO_1", "Metabolic disorder", "disease"], ["body height", "http://x/EFO_2", "Body measurement", "metabolism"]],
  sites: { rs200: ["10", 2000, "C", "T", "T", "TCF"], rs201: ["2", 2100, "A", "T", "T", "PAL"], rs202: ["5", 2200, "G", "A", "A,C", "OLD"], rs900: ["1", 1, "G", "A", "A", "CUR"] },
  samples: ["10,000 European ancestry cases"],
  groups: [
    ["rs200", 0, "A", "T", 1.3, 0, 1, "[1.2-1.4]", "1E-20", 555, 0, 3, 0, 3, [555, 556, 557], "complemented"], // study reported the minus strand
    ["rs201", 1, "T", "T", 0.1, 1, 1, "[0.05-0.15] cm increase", "2E-9", 600, 0, 1, 0, 1, [600], "ambiguous"],
    ["rs202", 1, "A", "A", 0.2, 1, -1, "[0.1-0.3] cm decrease", "3E-10", 700, 0, 2, 2, 5, [700, 701], "forward"],
    ["rs900", 0, "A", "A", 1.1, 0, 1, "", "1E-9", 800, 0, 1, 0, 1, [800], "forward"], // curated site: excluded
  ],
  studies: { "555": ["Author A", "2020", "Nat Genet", "A GWAS of T2D"], "600": ["B", "2021", "J", "Height"], "700": ["C", "2019", "J", "Height 2"], "701": ["D", "2022", "J", "Height 3"] },
  aliases: { rs2020: "rs202" }, // file uses a merged rsID
};

const genome = () => {
  const keep = new Set(bulkRsids(CV, GW));
  return parseGenotypeText(file23([
    ["rs100", "1", 1000, "AG"], ["rs101", "1", 1100, "CC"], ["rs102", "2", 1200, "DI"], ["rs103", "2", 1300, "--"],
    ["rs200", "10", 2000, "CT"], ["rs201", "2", 2100, "AT"], ["rs2020", "5", 2200, "AA"], ["rs900", "1", 1, "AA"],
  ]), keep);
};

describe("bulk ClinVar screen", () => {
  const r = screenClinVar(genome(), CV, [{ kind: "clingen", gene: "GENEA", disease: "Condition A", mondo: "", moi: "AR", classification: "Definitive", url: "", source: { source: "ClinGen", version: "", retrievedAt: "", url: "" } }]);
  it("counts tested, not-carried and no-call sites and never tests absent ones", () => {
    expect(r.tested).toBe(3);
    expect(r.notCarried).toBe(1);
    expect(r.noCall).toBe(1);
  });
  it("reports carried pathogenic alleles (SNV and I/D-coded deletion) as needing confirmation", () => {
    expect(r.carried.map((f) => f.record.rsid).sort()).toEqual(["rs100", "rs102"]);
    const a = r.carried.find((f) => f.record.rsid === "rs100")!;
    expect(a.category).toBe("pathogenic-carried");
    expect(a.headline).toMatch(/confirmation/);
    expect(a.headline).toMatch(/autosomal recessive/); // ClinGen applied to bulk genes too
    expect(a.limitations[0]).toMatch(/false positives/);
  });
  it("keeps the papers ClinVar cites for each carried variant", () => {
    expect(r.cites).toEqual({ "11": [111, 222], "13": [333] });
  });
});

describe("bulk GWAS explorer", () => {
  const r = screenGwas(genome(), GW, new Set(["rs900"]));
  const hit = (rs: string) => r.hits.find((h) => h.rsid === rs)!;
  it("orients minus-strand study alleles and counts copies", () => {
    expect(hit("rs200").effectForward).toBe("T");
    expect(hit("rs200").copies).toBe(1);
    expect(hit("rs200").strength).toBe("strong");
  });
  it("does not count copies at strand-ambiguous sites", () => {
    expect(hit("rs201").copies).toBeNull();
    expect(hit("rs201").notes.join(" ")).toMatch(/Strand-ambiguous/);
  });
  it("resolves merged rsIDs, flags conflicting evidence, and skips curated sites", () => {
    expect(hit("rs202").copies).toBe(2);
    expect(hit("rs202").strength).toBe("conflicting");
    expect(r.hits.some((h) => h.rsid === "rs900")).toBe(false);
  });
  it("carries every paper that reported the association, with catalog study metadata", () => {
    expect(hit("rs200").pmids).toEqual([555, 556, 557]);
    expect(r.studies["555"][3]).toBe("A GWAS of T2D");
  });
  it("exports CSV", () => {
    const csv = toCsv(r.hits);
    expect(csv.split("\n")[0]).toMatch(/^rsid,gene,trait/);
    expect(csv).toMatch(/555;556;557/);
  });
});

describe("bulk pipeline rules", () => {
  const base = { ClinicalSignificance: "Pathogenic", Assembly: "GRCh37", "RS# (dbSNP)": "123", OriginSimple: "germline", ReviewStatus: "criteria provided, single submitter", ReferenceAlleleVCF: "G", AlternateAlleleVCF: "A" };
  it("keeps only germline P/LP with rsID, ≥1 star and simple alleles", () => {
    expect(keepRow(base)).toBe(true);
    expect(keepRow({ ...base, ClinicalSignificance: "Conflicting classifications of pathogenicity" })).toBe(false);
    expect(keepRow({ ...base, ClinicalSignificance: "Uncertain significance" })).toBe(false);
    expect(keepRow({ ...base, ReviewStatus: "no assertion criteria provided" })).toBe(false);
    expect(keepRow({ ...base, "RS# (dbSNP)": "-1" })).toBe(false);
    expect(keepRow({ ...base, OriginSimple: "somatic" })).toBe(false);
    expect(keepRow({ ...base, Assembly: "GRCh38" })).toBe(false);
    expect(starsFor("reviewed by expert panel")).toBe(3);
    expect(starsFor("no assertion criteria provided")).toBe(0); // contains "criteria provided"
    expect(starsFor("criteria provided, single submitter")).toBe(1);
  });
  it("tells OR from beta and reads beta direction from the CI text", () => {
    expect(effectKind("[1.1-1.3]")).toEqual({ kind: "OR", dir: 0 });
    expect(effectKind("[0.1-0.2] unit decrease")).toEqual({ kind: "beta", dir: -1 });
    expect(effectKind("[0.1-0.2] mmol/L increase")).toEqual({ kind: "beta", dir: 1 });
  });
  it("picks the main alternate allele and orients against it", () => {
    expect(mainAltFor({ ref: "C", alts: ["A", "G", "T"], chrom: "1", pos37: 1, pos38: null, maf: 0.2, minor: "T" }, [])).toBe("T");
    expect(mainAltFor({ ref: "C", alts: ["A", "T"], chrom: "1", pos37: 1, pos38: null, maf: null, minor: null }, ["A", "T", "T"])).toBe("T");
    expect(orient("A", "C", "T")).toEqual({ allele: "T", how: "complemented" });
    expect(orient("T", "A", "T").how).toBe("ambiguous");
  });
  it("maps trait categories to report domains", () => {
    expect(domainFor("type 2 diabetes mellitus", ["Metabolic disorder"])).toBe("disease");
    expect(domainFor("LDL cholesterol", ["Lipid or lipoprotein measurement"])).toBe("metabolism");
    expect(domainFor("hand grip strength", ["Other measurement"])).toBe("performance");
    expect(domainFor("smoking initiation", ["Other trait"])).toBe("other");
  });
  it("gives the strength rubric documented in the README", () => {
    expect(strengthOf(3, 0, 3)).toBe("strong");
    expect(strengthOf(2, 2, 5)).toBe("conflicting");
    expect(strengthOf(1, 0, 1)).toBe("limited");
  });
});

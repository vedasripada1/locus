import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { guideSites } from "../src/core/genes";
import { buildReport } from "../src/core/interpret";
import { parseGenotypeText } from "../src/core/parse";
import { matchesSupplement, supplementResult, supplementResults, verdictLine } from "../src/core/supplements";
import { pairQuery, verifySupplement, type Known, type SeedEntry } from "../pipeline/supplements";
import { file23 } from "./fixtures";
import type { AuditEntry, EvidenceBundle, GeneResult, GeneVerdict, InterventionAssessment, SupplementEntry } from "../src/core/types";

const SRC = { source: "PubMed", version: "test", retrievedAt: "2026-01-01", url: "https://pubmed.ncbi.nlm.nih.gov/1/" };
const texts = new Map([["pmid:1", { text: "In 86 trials, magnesium lowered systolic BP by 2.00 mm Hg. The UL is 250 mg/day.", source: SRC, citation: "Test 2026" }]]);
const known: Known = { genes: new Set(["g1"]), marketed: new Set(["rs1"]), interventions: new Set(["iv1"]) };

function seedEntry(over: Partial<SeedEntry> = {}): SeedEntry {
  return {
    id: "mg", name: "Magnesium", aliases: [], what: "A mineral.",
    general: [{ ref: { pmid: "1" }, value: "Lowered BP by 2 mm Hg", quote: "magnesium lowered systolic BP by 2.00 mm Hg" }],
    generalNote: "In 86 trials it lowered blood pressure by 2.00 mm Hg.",
    safety: { upperLimit: { ref: { pmid: "1" }, value: "250 mg a day", quote: "The UL is 250 mg/day." }, cautions: [] },
    genes: ["g1"], marketed: ["rs1"], interventions: ["iv1"], mine: { terms: "magnesium", genes: ["TRPM6"] },
    ...over,
  };
}

describe("supplement verification", () => {
  it("keeps an entry whose quotes and numbers all verify", () => {
    const audit: AuditEntry[] = [];
    const out = verifySupplement(seedEntry({ generalNote: "It lowered systolic blood pressure by 2.00 mm Hg." }), texts as any, known, audit);
    expect(out?.general[0].citation).toBe("Test 2026");
    expect(out?.safety.upperLimit?.value).toBe("250 mg a day");
    expect(out).not.toHaveProperty("mine");
  });

  it("drops an entry whose general evidence quote is not in the source", () => {
    const audit: AuditEntry[] = [];
    const out = verifySupplement(seedEntry({ general: [{ ref: { pmid: "1" }, value: "Cures colds", quote: "magnesium cures colds" }] }), texts as any, known, audit);
    expect(out).toBeNull();
    expect(audit.some((a) => a.outcome === "dropped" && /quote not found/.test(a.detail))).toBe(true);
  });

  it("drops an entry whose plain text has a number no verified quote contains", () => {
    const audit: AuditEntry[] = [];
    expect(verifySupplement(seedEntry({ generalNote: "In 90 trials it lowered blood pressure." }), texts as any, known, audit)).toBeNull();
    expect(audit.at(-1)?.detail).toMatch(/numbers not in any verified quote: 90/);
  });

  it("drops a failing safety quote but keeps the card", () => {
    const audit: AuditEntry[] = [];
    const out = verifySupplement(seedEntry({
      generalNote: "It lowered systolic blood pressure by 2.00 mm Hg.",
      safety: { upperLimit: { ref: { pmid: "1" }, value: "500 mg a day", quote: "The UL is 500 mg/day." }, cautions: [{ ref: { pmid: "2" }, value: "x", quote: "y" }] },
    }), texts as any, known, audit);
    expect(out?.safety.upperLimit).toBeNull();
    expect(out?.safety.cautions).toEqual([]);
    expect(audit.filter((a) => a.outcome === "dropped").map((a) => a.subject)).toEqual(["supplement mg / upper limit", "supplement mg / caution"]);
  });

  it("treats an unknown gene, marketed site or intervention as a curation error", () => {
    expect(() => verifySupplement(seedEntry({ genes: ["nope"] }), texts as any, known, [])).toThrow(/unknown gene guide entry nope/);
    expect(() => verifySupplement(seedEntry({ interventions: ["nope"] }), texts as any, known, [])).toThrow(/unknown intervention nope/);
  });

  it("builds a PubMed query restricted to genetic-variant records", () => {
    expect(pairQuery({ variantTerms: "(SNP*[tiab])" }, "zinc OR zinc gluconate", "SLC30A8")).toBe("(zinc OR zinc gluconate) AND (SLC30A8[tiab]) AND (SNP*[tiab])");
  });
});

/** A gene guide result with only the fields the verdict reads. */
function gene(id: string, verdict: GeneVerdict, status: GeneResult["status"], tone?: "notable"): GeneResult {
  return { entry: { id, title: `${id} title`, gene: id.toUpperCase(), verdict } as GeneResult["entry"], sites: [], status,
    reading: status === "not-tested" ? null : { if: {}, text: "reading", tone } };
}
const entry = (genes: string[], interventions: string[] = []) =>
  ({ id: "s", name: "S", aliases: ["alias"], genes, interventions, map: [{ gene: "ABC1" }] } as unknown as SupplementEntry);
const none = { interventions: [] as InterventionAssessment[] };

describe("supplement verdict", () => {
  it("says DNA may change the advice only for a notable reading at a gene whose verdict allows it", () => {
    const r = supplementResult(entry(["a"]), [gene("a", "changes-advice", "read", "notable")], none);
    expect(r.verdict).toBe("dna-changes");
    expect(verdictLine(r)).toMatch(/a title/);
    // A notable reading at a gene with no proven action (e.g. FADS1 and omega-3) does not change the advice.
    expect(supplementResult(entry(["a"]), [gene("a", "no-proven-action", "read", "notable")], none).verdict).toBe("same");
    // The same gene without the notable genotype gives the same advice.
    expect(supplementResult(entry(["a"]), [gene("a", "changes-advice", "read")], none).verdict).toBe("same");
  });

  it("prefers a blood test when a read gene says so, and never treats an untested gene as read", () => {
    expect(supplementResult(entry(["a", "b"]), [gene("a", "same-advice", "read"), gene("b", "test-instead", "read")], none).verdict).toBe("test-first");
    expect(supplementResult(entry(["b"]), [gene("b", "test-instead", "not-tested")], none).verdict).toBe("not-read");
    expect(supplementResult(entry([]), [], none).verdict).toBe("no-genes");
  });

  it("keeps sensitive genes (e.g. APOE) out of the verdict unless the person chose to see them", () => {
    const apoe = { ...gene("apoe", "limited", "read", "notable"), entry: { ...gene("apoe", "limited", "read").entry, sensitive: true } } as GeneResult;
    const hidden = supplementResult(entry(["apoe"]), [apoe], none);
    expect(hidden.verdict).toBe("no-genes");
    expect(hidden.genes).toEqual([]);
    expect(supplementResult(entry(["apoe"]), [apoe], none, true).verdict).toBe("dna-changes");
  });

  it("links only the curated actions that apply to the file", () => {
    const applied = { interventions: [{ intervention: { id: "iv1" } }, { intervention: { id: "other" } }] as InterventionAssessment[] };
    expect(supplementResult(entry([], ["iv1"]), [], applied).actions.map((a) => a.intervention.id)).toEqual(["iv1"]);
  });

  it("searches by name, alias and gene", () => {
    const r = supplementResult(entry([]), [], none);
    expect(matchesSupplement(r, "ALIAS")).toBe(true);
    expect(matchesSupplement(r, "abc1")).toBe(true);
    expect(matchesSupplement(r, "zzz")).toBe(false);
  });
});

describe("verified supplement guide in the bundle", () => {
  const real: EvidenceBundle = JSON.parse(readFileSync("src/evidence/bundle.json", "utf8"));
  const guide = real.supplements!;

  it("has general evidence for every supplement, and every link resolves", () => {
    expect(guide.entries.length).toBeGreaterThanOrEqual(12);
    const genes = new Set(real.geneGuide!.entries.map((e) => e.id));
    const marketed = new Set(real.geneGuide!.unsupported.map((u) => u.rsid));
    const ivs = new Set(real.interventions.map((i) => i.id));
    for (const e of guide.entries) {
      expect(e.general.length, e.id).toBeGreaterThan(0);
      for (const g of e.genes) expect(genes.has(g), `${e.id} → ${g}`).toBe(true);
      for (const m of e.marketed) expect(marketed.has(m), `${e.id} → ${m}`).toBe(true);
      for (const i of e.interventions) expect(ivs.has(i), `${e.id} → ${i}`).toBe(true);
    }
  });

  it("has a consistent literature map", () => {
    for (const e of guide.entries) {
      expect(e.map.length, e.id).toBeGreaterThan(0);
      for (const m of e.map) {
        expect(m.trials).toBeLessThanOrEqual(m.total);
        expect(m.screened.length).toBeLessThanOrEqual(m.trials);
        expect(m.humanInteraction).toBeLessThanOrEqual(m.screened.length);
      }
    }
  });

  it("reads a synthetic file end to end", () => {
    const at = (rsid: string) => real.geneGuide!.entries.flatMap((e) => e.sites).find((s) => s.rsid === rsid)!.site;
    const mthfr = at("rs1801133"), fads = at("rs174546");
    const text = file23([["rs1801133", mthfr.chrom, mthfr.pos37!, "AA"], ["rs174546", fads.chrom, fads.pos37!, "TT"]]);
    const keep = new Set([...real.sites, ...guideSites(real)].flatMap((s) => [s.rsid, ...s.aliases]));
    const report = buildReport(parseGenotypeText(text, keep), real);
    const by = (id: string) => supplementResults(real, report).find((r) => r.entry.id === id)!;
    expect(by("folate").verdict).toBe("dna-changes");
    expect(by("folate").actions.map((a) => a.intervention.id)).toContain("riboflavin-mthfr-tt");
    expect(by("omega3").verdict).toBe("same");
    expect(by("vitd").verdict).toBe("not-read");
    expect(by("magnesium").verdict).toBe("no-genes");
  });
});

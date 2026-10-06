import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { holds, geneResult, guideSites } from "../src/core/genes";
import { assessIntervention, buildReport, EMPTY_CONTEXT } from "../src/core/interpret";
import { parseGenotypeText } from "../src/core/parse";
import { genesMd } from "../src/core/export";
import { orphanNumbers } from "../pipeline/genes";
import { BUNDLE, KEEP, file23, site } from "./fixtures";
import type { EvidenceBundle, GeneGuideEntry, GeneSiteResult, Intervention, SiteMatch } from "../src/core/types";

const matched = (rsid: string, alleles: string[]): SiteMatch =>
  ({ site: site({ rsid }), status: "matched", call: null, forwardAlleles: alleles, orientation: "forward", positionCheck: "ok", notes: [] });
const missing = (rsid: string): SiteMatch =>
  ({ site: site({ rsid }), status: "not-on-array", call: null, forwardAlleles: [], orientation: null, positionCheck: "not-checked", notes: [] });
const sr = (rsid: string, copies: number | null): GeneSiteResult => ({ rsid, copies, match: copies == null ? missing(rsid) : matched(rsid, []) });

describe("gene guide readings", () => {
  it("matches exact copies and ranges per site", () => {
    expect(holds({ if: { rs1: 2 }, text: "" }, [sr("rs1", 2)])).toBe(true);
    expect(holds({ if: { rs1: 2 }, text: "" }, [sr("rs1", 1)])).toBe(false);
    expect(holds({ if: { rs1: [0, 1] }, text: "" }, [sr("rs1", 0)])).toBe(true);
  });

  it("never reads an untested site as 'not carried'", () => {
    expect(holds({ if: { rs1: 0 }, text: "" }, [sr("rs1", null)])).toBe(false);
    expect(holds({ if: {}, text: "" }, [sr("rs1", null)])).toBe(false);
    // total 0 needs every site read; carrying at a read site is enough for total >= 1
    expect(holds({ if: { total: 0 }, text: "" }, [sr("rs1", 0), sr("rs2", null)])).toBe(false);
    expect(holds({ if: { total: [1, 4] }, text: "" }, [sr("rs1", 1), sr("rs2", null)])).toBe(true);
    expect(holds({ if: { total: 0 }, text: "" }, [sr("rs1", 0), sr("rs2", 0)])).toBe(true);
  });

  it("reports not-tested when no site is on the chip", () => {
    const entry = { id: "x", sites: [{ rsid: "rs1", allele: "T" }], readings: [{ if: { rs1: 0 }, text: "none" }] } as unknown as GeneGuideEntry;
    const r = geneResult(entry, () => missing("rs1"));
    expect(r.status).toBe("not-tested");
    expect(r.reading).toBeNull();
    const r2 = geneResult(entry, () => matched("rs1", ["C", "C"]));
    expect(r2.reading?.text).toBe("none");
  });
});

describe("site triggers", () => {
  const iv = { id: "t", triggers: [{ site: "rs1", allele: "A", when: "homozygous" }], generalEvidence: [], genotypeEvidence: [], contextFlags: [] } as unknown as Intervention;
  it("fires only on the stated genotype, and never on an untested site", () => {
    expect(assessIntervention(iv, [], [], EMPTY_CONTEXT, new Map([["rs1", matched("rs1", ["A", "A"])]]))).not.toBeNull();
    expect(assessIntervention(iv, [], [], EMPTY_CONTEXT, new Map([["rs1", matched("rs1", ["A", "G"])]]))).toBeNull();
    expect(assessIntervention(iv, [], [], EMPTY_CONTEXT, new Map([["rs1", missing("rs1")]]))).toBeNull();
    const not = { ...iv, triggers: [{ site: "rs1", allele: "A", when: "not-carried" }] } as Intervention;
    expect(assessIntervention(not, [], [], EMPTY_CONTEXT, new Map([["rs1", missing("rs1")]]))).toBeNull();
  });
});

describe("number check", () => {
  it("ignores digits inside names but flags unsourced quantities", () => {
    expect(orphanNumbers(["omega-3 and ε4 and ALDH2*2 in 23andMe files"], [])).toEqual([]);
    expect(orphanNumbers(["lowered by 5.6 mmHg"], [{ quote: "a drop of 5.6±2.6 mm Hg" }])).toEqual([]);
    expect(orphanNumbers(["about 40% of people"], [{ quote: "no numbers here" }])).toEqual([40]);
  });
});

// The real, verified bundle (built by pipeline/build.ts).
const real: EvidenceBundle = JSON.parse(readFileSync("src/evidence/bundle.json", "utf8"));

describe("verified gene guide in the bundle", () => {
  const guide = real.geneGuide!;
  it("is present and every entry has quotes or linked actions", () => {
    expect(guide.entries.length).toBeGreaterThan(15);
    for (const e of guide.entries) expect(e.evidence.length + (e.interventions?.length ?? 0)).toBeGreaterThan(0);
  });

  it("gives a reading for every fully read genotype of every gene", () => {
    for (const e of guide.entries) {
      const combos = e.sites.reduce<number[][]>((acc) => acc.flatMap((c) => [0, 1, 2].map((n) => [...c, n])), [[]]);
      for (const c of combos) {
        const sites = e.sites.map((s, i) => sr(s.rsid, c[i]));
        expect(e.readings.some((r) => holds(r, sites)), `${e.id} ${c.join(",")}`).toBe(true);
      }
    }
  });

  it("only refers to its own sites in readings, and linked actions exist", () => {
    const ids = new Set(real.interventions.map((i) => i.id));
    for (const e of guide.entries) {
      for (const r of e.readings) for (const k of Object.keys(r.if)) if (k !== "total") expect(e.sites.map((s) => s.rsid), e.id).toContain(k);
      for (const id of e.interventions ?? []) expect(ids.has(id), `${e.id} → ${id}`).toBe(true);
    }
  });

  it("reads the metabolic genes from a synthetic file, and keeps the FH note", () => {
    const at = (rsid: string) => guide.entries.flatMap((e) => e.sites).find((s) => s.rsid === rsid)!.site;
    const rows: [string, string][] = [["rs738409", "GG"], ["rs58542926", "CC"], ["rs2231142", "GT"], ["rs662799", "AG"]];
    const text = file23(rows.map(([rs, g]) => [rs, at(rs).chrom, at(rs).pos37!, g]));
    const keep = new Set([...real.sites, ...guideSites(real)].flatMap((s) => [s.rsid, ...s.aliases]));
    const r = buildReport(parseGenotypeText(text, keep), real);
    const g = (id: string) => r.genes!.find((x) => x.entry.id === id)!;
    expect(g("pnpla3").reading?.text).toMatch(/^Two copies of the 148M/);
    expect(g("pnpla3").entry.verdict).toBe("limited");
    expect(g("tm6sf2").reading?.text).toMatch(/don't carry/);
    expect(g("abcg2").reading?.text).toMatch(/^One copy of the 141K/);
    expect(g("apoa5").reading?.text).toMatch(/^One copy of the -1131C/);
    expect(guide.entries.filter((e) => e.area === "metabolic").map((e) => e.id)).toEqual(expect.arrayContaining(["tcf7l2", "pnpla3", "tm6sf2", "abcg2", "apoa5"]));
    expect(guide.notes.find((n) => n.id === "fh")?.evidence.length).toBe(3);
  });

  it("reads a synthetic file end to end and exports it", () => {
    const at = (rsid: string) => guide.entries.flatMap((e) => e.sites).find((s) => s.rsid === rsid)!.site;
    const earwax = at("rs17822931"), mthfr = at("rs1801133");
    const text = file23([["rs17822931", earwax.chrom, earwax.pos37!, "TT"], ["rs1801133", mthfr.chrom, mthfr.pos37!, "AA"]]);
    const keep = new Set([...real.sites, ...guideSites(real)].flatMap((s) => [s.rsid, ...s.aliases]));
    const r = buildReport(parseGenotypeText(text, keep), real);
    const g = (id: string) => r.genes!.find((x) => x.entry.id === id)!;
    expect(g("earwax").reading?.text).toMatch(/dry/);
    expect(g("mthfr").reading?.text).toMatch(/Two copies of 677T/);
    expect(g("lpa").status).toBe("not-tested");
    expect(r.interventions.map((a) => a.intervention.id)).toContain("riboflavin-mthfr-tt");
    expect(r.interventions.map((a) => a.intervention.id)).not.toContain("lpa-test");
    const md = genesMd(r, { showSensitive: false });
    expect(md).toMatch(/Earwax type/);
    expect(md).not.toMatch(/APOE and fish oil/);
  });
});

it("fixture bundle without a gene guide still builds a report", () => {
  const r = buildReport(parseGenotypeText(file23([]), KEEP), BUNDLE);
  expect(r.genes).toEqual([]);
});

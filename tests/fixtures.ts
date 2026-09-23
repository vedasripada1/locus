// Synthetic fixtures only. No real person's genotype appears anywhere in this repo.
import type { ClinGenValidity, ClinVarRecord, EvidenceBundle, GwasAssociation, Intervention, SourceVersion, TraitTopic, VariantSite } from "../src/core/types";

const SRC: SourceVersion = { source: "dbSNP", version: "test", retrievedAt: "2026-01-01", url: "https://example.test" };

export function site(p: Partial<VariantSite> & Pick<VariantSite, "rsid">): VariantSite {
  const s: VariantSite = { aliases: [], gene: "GENE", chrom: "1", pos37: 1000, pos38: 2000, ref: "C", alts: ["T"], mainAlt: "", kind: "snv", domain: "disease", label: p.rsid, sensitive: false, source: SRC, ...p };
  return { ...s, mainAlt: p.mainAlt ?? s.alts[0] };
}

export const SITES: VariantSite[] = [
  site({ rsid: "rs1", gene: "CLIN", chrom: "6", pos37: 100, ref: "G", alts: ["A"], domain: "clinical", label: "CLIN p.X" }),
  site({ rsid: "rs2", chrom: "10", pos37: 200, ref: "C", alts: ["T"], label: "T2D-ish" }), // plain SNV
  site({ rsid: "rs3", chrom: "2", pos37: 300, ref: "A", alts: ["T"], label: "Palindromic" }), // A/T palindrome
  site({ rsid: "rs4", chrom: "7", pos37: 400, ref: "CTT", alts: ["-"], kind: "deletion", domain: "clinical", gene: "DELG", label: "Deletion" }),
  site({ rsid: "rs5", chrom: "1", pos37: 500, ref: "G", alts: ["A"], aliases: ["rs55"], label: "Merged" }),
  site({ rsid: "rs6", chrom: "19", pos37: 45411941, ref: "T", alts: ["C"], gene: "APOE", sensitive: true, label: "APOE rs429358" }),
  site({ rsid: "rs7", chrom: "19", pos37: 45412079, ref: "C", alts: ["T"], gene: "APOE", sensitive: true, label: "APOE rs7412" }),
  site({ rsid: "rs8", chrom: "X", pos37: 800, ref: "G", alts: ["A"], label: "X-linked" }),
  site({ rsid: "rs9", chrom: "3", pos37: 900, ref: "C", alts: ["T"], domain: "performance", label: "Perf" }),
  site({ rsid: "rs10", chrom: "4", pos37: 1000, ref: "G", alts: ["A"], domain: "clinical", gene: "CONF", label: "Conflicted" }),
  site({ rsid: "rs11", chrom: "5", pos37: 1100, ref: "C", alts: ["T"], domain: "metabolism", label: "Never on chip" }),
  site({ rsid: "rs12", chrom: "1", pos37: 1200, ref: "C", alts: ["A", "G", "T"], mainAlt: "T", label: "Multi-allelic" }),
];

const cvSrc: SourceVersion = { source: "ClinVar", version: "test", retrievedAt: "2026-01-01", url: "https://example.test" };
const cv = (p: Partial<ClinVarRecord> & Pick<ClinVarRecord, "rsid" | "altAllele" | "classification">): ClinVarRecord => ({
  kind: "clinvar", id: `VCV-${p.rsid}`, title: `${p.rsid} title`, reviewStatus: "criteria provided, multiple submitters, no conflicts", stars: 2,
  conflicting: false, conditions: ["Test condition"], rcvs: [], lastEvaluated: null, url: "https://example.test", source: cvSrc, ...p,
});
export const CLINVAR: ClinVarRecord[] = [
  cv({ rsid: "rs1", altAllele: "A", classification: "Pathogenic" }),
  cv({ rsid: "rs4", altAllele: "-", classification: "Pathogenic" }),
  cv({ rsid: "rs10", altAllele: "A", classification: "Conflicting classifications of pathogenicity", reviewStatus: "criteria provided, conflicting classifications", stars: 1, conflicting: true }),
];
export const CLINGEN: ClinGenValidity[] = [
  { kind: "clingen", gene: "CLIN", disease: "test recessive disease", mondo: "MONDO:1", moi: "AR", classification: "Definitive", url: "", source: { ...cvSrc, source: "ClinGen" } },
];

const gwSrc: SourceVersion = { source: "GWAS Catalog", version: "test", retrievedAt: "2026-01-01", url: "" };
let gid = 0;
export const gw = (p: Partial<GwasAssociation> & Pick<GwasAssociation, "rsid" | "effectAllele" | "traitLabel">): GwasAssociation => ({
  kind: "gwas", id: String(++gid), efoId: "EFO_1", reportedTrait: p.traitLabel, pValue: "1e-20", pExponent: -20, orValue: 1.3, beta: null, ci: null,
  riskFrequency: null, studyAccession: `GCST${gid}`, pmid: `${1000 + gid}`, firstAuthor: "Test A", initialSampleSize: "10,000 European ancestry cases",
  ancestry: ["10000 European"], url: "", paperUrl: "", source: gwSrc, ...p,
});
export const TOPICS: TraitTopic[] = [
  { id: "t2d", label: "Type 2 diabetes", phrase: "type 2 diabetes", domain: "disease", rsids: ["rs2"], traitPattern: "", description: "", absoluteRiskBaseline: null },
  { id: "pal", phrase: "palindromic trait", label: "Palindromic trait", domain: "metabolism", rsids: ["rs3"], traitPattern: "", description: "", absoluteRiskBaseline: null },
  { id: "alzheimers", phrase: "Alzheimer disease", label: "Alzheimer disease", domain: "disease", rsids: ["rs6", "rs7"], traitPattern: "", description: "", absoluteRiskBaseline: null },
  { id: "performance", phrase: "athletic performance", label: "Athletic performance", domain: "performance", rsids: ["rs9"], traitPattern: "", description: "", absoluteRiskBaseline: null },
  { id: "untested", phrase: "untested trait", label: "Untested trait", domain: "metabolism", rsids: ["rs11"], traitPattern: "", description: "", absoluteRiskBaseline: null },
];
export const GWAS: GwasAssociation[] = [
  // Three papers, one reports the other allele with OR<1 (same direction), one on the minus strand.
  gw({ rsid: "rs2", effectAllele: "T", traitLabel: "Type 2 diabetes", orValue: 1.4 }),
  gw({ rsid: "rs2", effectAllele: "C", traitLabel: "Type 2 diabetes", orValue: 0.7 }),
  gw({ rsid: "rs2", effectAllele: "A", traitLabel: "Type 2 diabetes", orValue: 1.35 }), // A = complement of T
  gw({ rsid: "rs3", effectAllele: "T", traitLabel: "Palindromic trait", orValue: null, beta: "0.1 unit increase" }),
];

const pm = (pmid: string): SourceVersion => ({ source: "PubMed", version: `PMID ${pmid}`, retrievedAt: "2026-01-01", url: "" });
export const INTERVENTIONS: Intervention[] = [
  {
    id: "lifestyle", triggers: [{ topic: "t2d", when: "effect-allele-carried" }], triggerNote: "", name: "Lifestyle", type: "lifestyle", summary: "",
    generalEvidence: [{ ref: { pmid: "1" }, citation: "", title: "", doi: null, design: "randomized controlled trial", sampleSize: null, population: null, exposure: null, outcomes: [], harms: null, humans: true, genotypeInteraction: "not-tested", source: pm("1") }],
    genotypeEvidence: [], safety: null, limitations: [],
    contextFlags: [{ field: "medications", matchAny: ["metformin"], message: "MED FLAG" }],
  },
  {
    id: "carrier-action", triggers: [{ clinvar: "rs1", when: "pathogenic-carried" }], triggerNote: "", name: "Discuss", type: "discuss with clinician", summary: "",
    generalEvidence: [{ ref: { pmid: "2" }, citation: "", title: "", doi: null, design: "guideline", sampleSize: null, population: null, exposure: null, outcomes: [], harms: null, humans: true, genotypeInteraction: "not-tested", source: pm("2") }],
    genotypeEvidence: [], safety: null, limitations: [], contextFlags: [],
  },
];

export const BUNDLE: EvidenceBundle = {
  schemaVersion: 1, builtAt: "2026-01-01T00:00:00Z", sources: [], sites: SITES, clinvar: CLINVAR, clingen: CLINGEN, gwas: GWAS,
  traits: TOPICS, interventions: INTERVENTIONS, literature: [], audit: [],
};

export const KEEP = new Set(SITES.flatMap((s) => [s.rsid, ...s.aliases]));

/** Build a synthetic 23andMe file. Rows: [rsid, chrom, pos, genotype]. */
export function file23(rows: [string, string, number, string][], opts: { build?: string; filler?: number } = {}): string {
  const head = [
    "# This data file generated by 23andMe at: Thu Jan 01 00:00:00 2026",
    "#",
    `# More information on reference human assembly ${opts.build ?? "build 37"} (a.k.a. Annotation Release 104):`,
    "# rsid\tchromosome\tposition\tgenotype",
  ];
  const filler = Array.from({ length: opts.filler ?? 50 }, (_, i) => `rs9${String(i).padStart(6, "0")}\t1\t${10000 + i}\tAG`);
  return [...head, ...rows.map((r) => r.join("\t")), ...filler].join("\n") + "\n";
}

/** Build a synthetic AncestryDNA file. Rows: [rsid, chrom(1-26), pos, a1, a2]. */
export function fileAnc(rows: [string, string, number, string, string][], filler = 50): string {
  const head = [
    "#AncestryDNA raw data download",
    "#This file was generated by AncestryDNA at: 01/01/2026 00:00:00 UTC",
    "#Data was collected using AncestryDNA array version: V2.0",
    "#Genetic data is provided below as five TAB delimited columns. Each line corresponds to a SNP. Column one provides the SNP identifier (rsID where possible). Columns two and three contain the chromosome and basepair position of the SNP using human reference build 37.1 coordinates.",
    "rsid\tchromosome\tposition\tallele1\tallele2",
  ];
  const fill = Array.from({ length: filler }, (_, i) => `rs8${String(i).padStart(6, "0")}\t2\t${20000 + i}\tC\tC`);
  return [...head, ...rows.map((r) => r.join("\t")), ...fill].join("\r\n") + "\r\n";
}

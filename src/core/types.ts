// Core data model. Every layer (retrieval → matching → interpretation →
// narrative) communicates only through these types, so each step can be
// audited and tested on its own.

// ─── Input: parsed genotype file ────────────────────────────────────────────

export type FileFormat = "23andme" | "ancestrydna";
export type GenomeBuild = "GRCh37" | "GRCh38" | "unknown";

/** One call as reported by the vendor, before any interpretation. */
export interface GenotypeCall {
  rsid: string;
  chrom: string; // normalised: 1-22, X, Y, MT
  pos: number;
  /** Alleles as reported (A/C/G/T, or I/D for indels). Empty = no-call. */
  alleles: string[];
  raw: string; // exactly what the file said, for display
  /** How this call was linked to an evidence site (default: by rsID). */
  matchedBy?: "rsid" | "position";
}

/** Every row of the file, column-wise (compact enough for ~700k rows). */
export interface GenomeTable {
  id: string[];
  chrom: string[];
  pos: Int32Array;
  geno: string[]; // normalised alleles joined ("AG", "DI", "" for no-call)
}

export interface ParseIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  line?: number;
}

export interface ParseStats {
  totalRows: number;
  calledRows: number;
  noCallRows: number;
  malformedRows: number;
  duplicateRsids: number;
  callRate: number; // calledRows / (calledRows + noCallRows)
  chromosomes: Record<string, number>;
}

export interface ParsedGenome {
  format: FileFormat;
  build: GenomeBuild;
  buildEvidence: string; // header text that told us the build, or why unknown
  /** Calls for sites with evidence (keyed by the evidence site's rsID). */
  calls: Map<string, GenotypeCall>;
  /** The whole file as a table, when parsed with { fullTable: true }. */
  table?: GenomeTable;
  stats: ParseStats;
  issues: ParseIssue[];
}

// ─── Evidence bundle (produced offline by /pipeline) ────────────────────────

export type Domain = "clinical" | "disease" | "metabolism" | "performance";

export interface SourceVersion {
  source: "ClinVar" | "ClinGen" | "GWAS Catalog" | "dbSNP" | "PubMed" | "Web";
  version: string; // release / record version as reported by the source
  retrievedAt: string; // ISO date
  url: string;
}

/** Reference description of a site, from dbSNP (forward strand). */
export interface VariantSite {
  rsid: string;
  aliases: string[]; // merged rsIDs that should resolve to this site
  gene: string;
  chrom: string;
  pos37: number | null;
  pos38: number | null;
  ref: string; // forward-strand reference allele (GRCh38)
  alts: string[]; // forward-strand alternates known to dbSNP
  /** Most frequent alternate allele in dbSNP frequency data; defines the biallelic pair used for strand checks. */
  mainAlt: string;
  kind: "snv" | "deletion" | "insertion" | "other";
  domain: Domain;
  /** Curator label for the site, e.g. "HFE C282Y". */
  label: string;
  /** Hidden until the user opts in (e.g. APOE / Alzheimer disease). */
  sensitive: boolean;
  curatorNote?: string;
  source: SourceVersion;
}

export type ReviewStars = 0 | 1 | 2 | 3 | 4;

/** One variant–condition classification (ClinVar RCV record). */
export interface RcvClassification {
  rcv: string; // accession.version
  condition: string;
  classification: string;
  reviewStatus: string;
  stars: ReviewStars;
}

export interface ClinVarRecord {
  kind: "clinvar";
  id: string; // VCV accession with version
  rsid: string;
  title: string;
  altAllele: string; // forward strand, from canonical SPDI
  classification: string; // ClinVar aggregate germline classification, verbatim
  reviewStatus: string;
  stars: ReviewStars;
  conflicting: boolean;
  conditions: string[];
  /** Per-condition classifications from the full VCV record. */
  rcvs: RcvClassification[];
  /** Frequency of this (disease) allele in 1000 Genomes, when known. */
  alleleFrequency?: import("./clinicalcheck").AlleleFreq | null;
  lastEvaluated: string | null;
  url: string;
  source: SourceVersion;
}

export interface ClinGenValidity {
  kind: "clingen";
  gene: string;
  disease: string;
  mondo: string;
  moi: string; // AD, AR, XL, ...
  classification: string; // Definitive, Strong, ...
  url: string;
  source: SourceVersion;
}

export interface GwasAssociation {
  kind: "gwas";
  id: string; // association id
  rsid: string;
  effectAllele: string; // as reported by the catalog
  traitLabel: string; // curated group label (e.g. "Type 2 diabetes")
  efoId: string;
  reportedTrait: string;
  pValue: string; // mantissa × 10^exponent, kept as text (can underflow)
  pExponent: number;
  orValue: number | null;
  beta: string | null; // verbatim e.g. "0.04 unit increase"
  ci: string | null;
  riskFrequency: string | null;
  studyAccession: string;
  pmid: string;
  firstAuthor: string;
  initialSampleSize: string;
  ancestry: string[];
  url: string; // study page
  paperUrl: string;
  source: SourceVersion;
}

export interface LiteratureCandidate {
  pmid: string;
  doi: string | null;
  title: string;
  journal: string;
  year: string;
  publicationTypes: string[];
  design: StudyDesign;
  humans: boolean;
  animalOnly: boolean;
  /** Auto-screened: abstract mentions genotype-by-intervention terms. */
  mentionsGeneInteraction: boolean;
  sampleSize: { value: string; snippet: string } | null; // auto-extracted, unverified
  /** e.g. "animal-only", "mechanistic/in vitro", "not yet MeSH-indexed". */
  flags: string[];
  topic: string; // literature topic id
  query: string;
  url: string;
  source: SourceVersion;
}

export type StudyDesign =
  | "meta-analysis"
  | "systematic review"
  | "randomized controlled trial"
  | "guideline"
  | "review"
  | "observational"
  | "other";

/** A field whose value is backed by a verbatim quote from the source. */
export interface Quoted<T = string> {
  value: T;
  quote: string;
}

export interface InterventionStudy {
  ref: { pmid?: string; pmcid?: string; url?: string };
  citation: string; // "Author, Journal Year" — built from fetched metadata
  title: string;
  doi: string | null;
  design: StudyDesign;
  sampleSize: Quoted | null;
  population: Quoted | null;
  exposure: Quoted | null; // dose / food / dietary pattern
  outcomes: Quoted[];
  harms: Quoted | null;
  humans: boolean;
  /** Does this study test whether the effect differs by genotype? */
  genotypeInteraction: "tested-difference" | "tested-no-difference" | "not-tested";
  source: SourceVersion;
}

export type Trigger =
  | { topic: string; when: "effect-allele-carried" | "tested" }
  | { site: string; allele: string; when: "carried" | "homozygous" | "not-carried" } // a gene-guide site, forward-strand allele
  | { clinvar: string; when: "pathogenic-carried" | "alt-carried" | "alt-homozygous" | "alt-not-carried" }
  | { clinvarAll: string[]; when: "alt-carried" }; // every listed site carries its ClinVar allele

/** A quoted fact with the source it was verified against. */
export interface SourcedQuote extends Quoted {
  source: SourceVersion;
  citation: string;
}

export interface Intervention {
  id: string;
  triggers: Trigger[];
  triggerNote: string;
  name: string;
  type: "food" | "dietary pattern" | "lifestyle" | "supplement" | "discuss with clinician";
  summary: string; // plain-language, only restates quoted evidence
  /** Evidence that the intervention affects the condition at all. */
  generalEvidence: InterventionStudy[];
  /** Evidence about whether the effect differs by genotype. */
  genotypeEvidence: InterventionStudy[];
  safety: {
    upperLimit: SourcedQuote | null;
    adverseEffects: SourcedQuote[];
    interactions: SourcedQuote[]; // medication / condition interactions
  } | null;
  limitations: string[];
  /** Keywords matched against the user's context (medications, diet, etc.). */
  contextFlags: ContextFlag[];
}

export interface ContextFlag {
  field: keyof UserContext;
  matchAny: string[]; // case-insensitive substrings
  message: string;
  /** If the message cites a study, the verified quote backing it. */
  evidence?: SourcedQuote;
}

export interface EvidenceBundle {
  schemaVersion: 1;
  builtAt: string;
  sources: SourceVersion[];
  sites: VariantSite[];
  clinvar: ClinVarRecord[];
  clingen: ClinGenValidity[];
  gwas: GwasAssociation[];
  /** Curated trait groupings: which GWAS traits we show per site. */
  traits: TraitTopic[];
  interventions: Intervention[];
  literature: LiteratureCandidate[];
  /** Claims dropped by verification, kept for audit. */
  audit: AuditEntry[];
  /** Report-level warnings, each backed by verified quotes. */
  warnings?: VerifiedWarning[];
  /** Verified gene guide (traits, nutrition, fitness); see pipeline/genes.ts. */
  geneGuide?: GeneGuide;
}

export interface VerifiedWarning { id: string; title: string; summary: string; quotes: SourcedQuote[] }

export interface TraitTopic {
  id: string;
  label: string;
  domain: Domain;
  rsids: string[];
  traitPattern: string; // regex over GWAS Catalog EFO trait labels
  reportedPattern?: string; // optional regex over the study's reported trait
  phrase: string; // lower-case noun phrase used in sentences
  /** Plain explanation of what the trait is; no risk claims. */
  description: string;
  /** Recognised baseline for absolute risk; null = never shown. */
  absoluteRiskBaseline: null;
}

export interface AuditEntry {
  stage: "fetch" | "verify" | "build";
  subject: string;
  outcome: "dropped" | "warning" | "ok";
  detail: string;
}

// ─── Matching ───────────────────────────────────────────────────────────────

export type MatchStatus =
  | "matched"
  | "not-on-array" // rsid absent from the file: NOT a negative result
  | "no-call" // on the array but the genotype could not be read
  | "allele-mismatch"; // observed alleles inconsistent with the reference site

export type Orientation =
  | "forward" // file alleles ⊆ reference alleles
  | "complemented" // file alleles matched after complementing (non-palindromic)
  | "ambiguous-palindromic" // A/T or C/G site: strand cannot be checked from alleles
  | "indel-coded"; // I/D calls mapped to deletion/insertion alleles

export interface SiteMatch {
  site: VariantSite;
  status: MatchStatus;
  call: GenotypeCall | null;
  /** Genotype on the forward strand (after complementing, if needed). */
  forwardAlleles: string[];
  orientation: Orientation | null;
  positionCheck: "ok" | "mismatch" | "not-checked";
  notes: string[];
}

// ─── Interpretation ─────────────────────────────────────────────────────────

export type EvidenceStrength = "strong" | "moderate" | "limited" | "conflicting" | "insufficient";

export interface ClinicalFinding {
  kind: "clinical";
  match: SiteMatch;
  record: ClinVarRecord;
  clingen: ClinGenValidity[];
  altCopies: number | null; // null = could not be determined
  zygosity: "homozygous" | "heterozygous" | "hemizygous" | "not carried" | "unknown";
  category:
    | "pathogenic-carried" // P/LP allele observed → needs confirmation
    | "risk-factor-carried"
    | "conflicting" // ClinVar submitters disagree
    | "uncertain" // VUS
    | "annotation" // benign, drug response, association, protective, other
    | "not-carried" // tested; the ClinVar allele was not observed
    | "not-tested"; // not on the array / no-call / allele mismatch
  headline: string;
  limitations: string[];
}

export interface GwasFinding {
  kind: "gwas";
  topic: TraitTopic;
  match: SiteMatch;
  lead: GwasAssociation; // representative association (largest/strongest)
  supporting: GwasAssociation[]; // other genome-wide significant associations
  effectAlleleForward: string | null;
  effectCopies: number | null; // null = orientation uncertain → not counted
  direction: "increase" | "decrease" | "unclear";
  consistency: { concordant: number; discordant: number; studies: number };
  strength: EvidenceStrength;
  headline: string;
  limitations: string[];
}

export interface CompositeFinding {
  kind: "composite";
  id: string; // e.g. "apoe"
  topic: TraitTopic;
  matches: SiteMatch[];
  result: string; // e.g. "ε3/ε4"
  ambiguity: string | null;
  headline: string;
  limitations: string[];
}

/** A tested topic with no qualifying evidence: shown so absence is explicit. */
export interface NoEvidenceFinding {
  kind: "no-evidence";
  topic: TraitTopic;
  matches: SiteMatch[];
  headline: string;
  limitations: string[];
}

export type Finding = ClinicalFinding | GwasFinding | CompositeFinding | NoEvidenceFinding;

export interface InterventionAssessment {
  intervention: Intervention;
  triggeredBy: string[]; // human-readable reasons
  generalSupport: EvidenceStrength;
  genotypeSpecific: "difference-reported" | "tested-no-difference" | "not-established";
  bestDesign: string; // highest-ranked human study design behind the item
  contextWarnings: string[];
}

export interface UserContext {
  ageRange: string;
  ancestry: string;
  diagnoses: string;
  medications: string;
  allergies: string;
  dietaryRestrictions: string;
  goals: string;
}

export interface Report {
  generatedAt: string;
  file: { format: FileFormat; build: GenomeBuild; stats: ParseStats; issues: ParseIssue[] };
  coverage: { total: number; matched: number; notOnArray: number; noCall: number; mismatch: number };
  matches: SiteMatch[];
  clinical: ClinicalFinding[];
  disease: Finding[];
  metabolism: Finding[];
  performance: Finding[];
  interventions: InterventionAssessment[];
  topicsWithoutAction: string[];
  contextNotes: string[];
  evidenceSources: SourceVersion[];
  /** Genome-wide tiers; null when the data files are unavailable. */
  bulk?: import("./bulk").BulkResult | null;
  bulkError?: string | null;
  /** Accuracy audit over every evidence-bearing row (from the worker). */
  audit?: (import("./audit").AuditSummary & { linkedByPosition: number }) | null;
  /** The whole file as a table. */
  table?: GenomeTable;
  /** 1000 Genomes allele frequencies for curated ClinVar sites. */
  alleleFreq?: import("./clinicalcheck").FreqTable;
  /** Verbatim reference text (GeneReviews, MedlinePlus). */
  refs?: import("./refs").References | null;
  /** Gene guide results for this file. */
  genes?: GeneResult[];
  /** Your genotype at sites often used in DNA diet reports (gene guide "unsupported" list). */
  genesUnsupported?: { rsid: string; match: SiteMatch }[];
}

// ─── Gene guide ────────────────────────────────────────────────────────────

export type GeneArea = "traits" | "nutrition" | "fitness" | "heart" | "medicines";
/** Does your genotype change what to do? */
export type GeneVerdict = "changes-advice" | "test-instead" | "same-advice" | "no-proven-action" | "trait" | "limited";

export interface GeneGuideSite {
  rsid: string;
  /** Forward-strand (GRCh37 plus) allele the readings count. */
  allele: string;
  alleleName: string;
  /** Amino acid of `allele`, verified against Ensembl VEP (coding variants only). */
  aa?: string;
  site: VariantSite;
  /** 1000 Genomes phase 3 frequency of `allele` by population (ALL, AFR, AMR, EAS, EUR, SAS). */
  freq: Record<string, number> | null;
  /** Distinct GWAS Catalog papers with p < 5e-8 at this site (null if the bulk download was unavailable). */
  gwasPubs: number | null;
  gwasTraits: string[];
}

export interface GeneReading { if: Record<string, number | [number, number]>; text: string; tone?: "notable" }

export interface GeneGuideEntry {
  id: string;
  gene: string;
  title: string;
  area: GeneArea;
  what: string;
  sites: GeneGuideSite[];
  readings: GeneReading[];
  verdict: GeneVerdict;
  verdictNote: string;
  actions?: string[];
  evidence: SourcedQuote[];
  interventions?: string[];
  caveat?: string;
  strandNote?: string;
  sensitive?: boolean;
}

export interface GeneGuide {
  builtAt: string;
  gwasAvailable: boolean;
  entries: GeneGuideEntry[];
  /** Sites often used for diet or fitness advice, with how much genome-wide evidence exists for them. */
  unsupported: { rsid: string; gene: string; claim: string; site: VariantSite; gwasPubs: number | null; gwasTraits: string[] }[];
  notes: { id: string; title: string; text: string; evidence: SourcedQuote[] }[];
}

export interface GeneSiteResult { rsid: string; match: SiteMatch; copies: number | null }
export interface GeneResult {
  entry: GeneGuideEntry;
  sites: GeneSiteResult[];
  /** The reading that applies, or null when a needed site wasn't tested or readable. */
  reading: GeneReading | null;
  status: "read" | "partial" | "not-tested";
}


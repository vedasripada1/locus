# Architecture

## Technical choices

| Choice | Why |
|---|---|
| **Static React + Vite app; analysis in the browser** | The strongest privacy guarantee is that genotypes never leave the device. With no backend, there is nothing to retain or breach. |
| **Web Worker parsing (with `fflate` for .zip)** | Raw files are 15–25 MB. Parsing off the main thread keeps the UI responsive, and only curated sites are kept. |
| **CSP `connect-src 'self'` in production** | Makes the "nothing leaves the device" promise enforceable: the page can only read its own static evidence files. |
| **Offline evidence pipeline (Node/tsx) → versioned JSON bundle** | Retrieval, verification and interpretation are separate and reproducible. The bundle is a reviewable artifact in git. |
| **Pure TypeScript core (`src/core`)** | Parsing, matching, interpretation and export are deterministic pure functions, unit-tested with Vitest. |
| **No LLM** | The spec allows an LLM only to summarise verified records. Fixed templates achieve that with zero hallucination risk. |

## Data model (`src/core/types.ts`)

```
EvidenceBundle ─┬─ sites: VariantSite[]          dbSNP: forward-strand ref/alts, mainAlt (by frequency), GRCh37/38 pos, aliases
                ├─ clinvar: ClinVarRecord[]      aggregate classification + rcvs[] (per-condition), stars, VCV.version
                ├─ clingen: ClinGenValidity[]    gene–disease, MOI, classification
                ├─ gwas: GwasAssociation[]       effect allele, OR/β, CI, p (mantissa/exponent text), study, sample, ancestry
                ├─ traits: TraitTopic[]          curated grouping: rsids + EFO trait regex + reported-trait regex
                ├─ interventions: Intervention[] studies split into generalEvidence / genotypeEvidence, safety, context flags
                ├─ literature: LiteratureCandidate[]
                ├─ sources: SourceVersion[]      source, version, retrievedAt, url
                ├─ audit: AuditEntry[]           every drop/warning with reason
                ├─ geneGuide: GeneGuide          verified gene cards (pipeline/genes.ts)
                └─ supplements: SupplementGuide  verified supplement cards + PubMed literature map (pipeline/supplements.ts)
ParsedGenome → SiteMatch[] → Finding (clinical | gwas | composite | no-evidence) → InterventionAssessment → Report
```

Every record carries a `SourceVersion`. Adding sites, topics or interventions means **adding seed data only**: `pipeline/seeds/*.json`, then `npm run evidence:all`. No model or UI change is needed. A new source (e.g. PharmGKB, Europe PMC) adds a retrieval module that emits the same record types.

## Retrieval (`pipeline/fetch.ts`, `pipeline/literature.ts`)

- **Curated vs retrieved:** seeds choose *which* sites, trait groups and papers to use. Every *fact* (alleles, classifications, effect sizes, sample sizes, titles, DOIs, publication types) comes from the fetched source.
- **ClinVar:** only single-variant records whose dbSNP cross-reference is the exact rsID are kept. SNV alleles come from canonical SPDI; indels are matched by net length change. Reference-allele records (e.g. `c.1601=`) are dropped with an audit entry. Per-condition RCV classifications come from the VCV XML.
- **GWAS:** only associations with p < 5×10⁻⁸ that match the topic's EFO regex, and optionally its reported-trait regex, are kept. Multi-SNP haplotype and interaction associations are excluded. Study metadata (sample, ancestry) is fetched for the strongest 6 per site/topic.
- **Literature candidates:** two PubMed queries per topic, one design-filtered (MA/SR/RCT/guideline) and one gene–diet. Each record is classified by publication type and MeSH (`Humans` / `Animals`), with a text fallback flagged "not yet MeSH-indexed". It gets an in-vitro/mechanistic flag, a genotype × intervention keyword screen, and a regex-extracted sample size shown with its snippet.

## Supplements (`pipeline/supplements.ts`, `src/core/supplements.ts`)

- **Seed:** one entry per supplement with general-evidence quotes, an upper limit and cautions, links to gene guide entries, marketed sites and interventions, and the terms and genes to mine.
- **Verification:** `verifySupplement` is pure (no network) and reuses the gene guide's `verifyQuotes` and `orphanNumbers`. Safety quotes are verified one at a time, so one failing caution doesn't drop the card. Unknown cross-references throw.
- **Literature map:** per gene, three PubMed counts (all records about supplement × gene × variant terms, trials, reviews), and the top trials screened with the same `screen` used for literature candidates. Reading list only.
- **Runtime:** `supplementResult` derives a verdict from the file's gene guide results and applied interventions using fixed rules, and `verdictLine` renders it from templates. Sensitive gene entries are excluded unless the person opts in.

## Verification (`pipeline/build.ts`)

For each curated intervention study or safety item:
1. Fetch the source text (PubMed abstract, extracted in document order with entities decoded; PMC full text; or the web page).
2. Normalise (NFKC, quotes, dashes, whitespace, case) and require the **quote to appear verbatim**.
3. Require **every standalone number in the value to appear in its quote** (numeric equality; thousands separators handled; ignores B12/D3-style names).
4. Drop failing studies. Drop interventions with no verified study. Drop supplements without a verified human RCT/MA/SR **and** a verified upper limit.
5. Context flags that cite a study are verified the same way.

This check found real bugs during development. Numeric XML entities (`&#x3bc;`) weren't being decoded, and the XML parser lost inline markup order (`D<sub>3</sub>` → `D`). Both would have silently stored corrupted source text.

## Matching (`src/core/match.ts`)

| Situation | Handling |
|---|---|
| rsID absent from file | `not-on-array`: "not tested; not a negative result" |
| `--`, `0 0`, discordant duplicate rows | `no-call` |
| Merged rsID | Resolved through dbSNP merge history, with a note |
| Position ≠ GRCh37/38 reference | Matched by rsID, flagged `mismatch` |
| Alleles ⊆ known forward alleles | `forward` |
| Complement ⊆ known (non-palindromic) | `complemented`, with a note |
| ref/mainAlt is A/T or C/G | `ambiguous-palindromic`: vendor forward strand assumed; GWAS effect-allele copies **not counted** |
| I/D calls | Mapped to the deletion/insertion allele (`indel-coded`), with a high-error-rate note |
| Otherwise | `allele-mismatch`: not interpreted |

Palindromy is judged on **ref vs the main alternate allele** (highest dbSNP allele count), not on every allele dbSNP lists. Otherwise multi-allelic sites like rs6025 (C>A,G,T) would all look ambiguous. Study effect alleles are oriented against the same main pair, so a catalog "T" at MTHFR (G>A, rare T) is read as the complemented main allele A.

## Interpretation (`src/core/interpret.ts`)

- **ClinVar category, in priority order:** aggregate conflicting → *conflicting*. Aggregate P/LP, or any per-condition P/LP at ≥2★ → *pathogenic*. Per-condition conflicting ≥1★ → *conflicting*. Then risk factor, VUS, other annotation. The ≥2★ promotion exists because the esummary aggregate can be an expert-panel drug-response call; Factor V Leiden's aggregate is "drug response" even though its thrombophilia RCV is Pathogenic at 2★.
- **GWAS:** each association's direction is expressed relative to the main alternate allele; flipping when a study reports the other allele is only valid for the main biallelic pair. The **lead association comes from the majority-direction cluster**, preferring study metadata, an OR, and the main-alt effect allele, so one mis-oriented study cannot flip a headline. Conflicting evidence gets a headline that states no direction.
- **APOE:** ε-type from rs429358/rs7412, checked against the expected reference alleles in the bundle, with unphased ambiguity stated.
- **Interventions:** triggered by findings (effect allele carried, ClinVar allele carried/homozygous/absent, or several ClinVar alleles together). The report shows "best evidence" (highest human design) and "genotype-specific" (from genotype-interaction studies only) separately.
- **Context:** only adds flags (ancestry mismatch with the lead study population; medication, diagnosis, allergy, diet and age keyword flags). It never changes a finding.

## Tests

- `tests/core.test.ts` (28 tests) and `tests/bulk.test.ts` (13 tests, genome-wide tiers): both input formats, CRLF/BOM, VCF/CSV/empty/corrupt rejection, low call rate, discordant duplicates, forward/complement/palindromic/multi-allelic/mismatch/indel/merged/position cases, the ClinVar category ladder, GWAS strand and majority logic, contradictory sources, APOE, no-evidence topics, context flags, "no evidence-based personalized action", sensitive-result hiding, JSON export excluding raw data, and verification dropping fabricated quotes, animal-only supplements and missing sources.
- `tests/supplements.test.ts` (14 tests): supplement verification (fabricated quotes, unsourced numbers, failing safety quotes, unknown links), the verdict ladder, sensitive-gene exclusion, bundle integrity, and a synthetic file end to end.
- `scripts/smoke.ts`: headless Chrome against the production build. It checks that the report renders for both demos, that every supplement card renders and its search works, that there are no console errors and zero external requests, and that delete works.

## Genome-wide tier (`pipeline/bulk/`, `src/core/bulk.ts`)

```
bulk:download ─▶ variant_summary.txt.gz ─┐                   ┌─▶ public/data/clinvar.json.gz  (≈243k P/LP variants + cited PMIDs)
                 var_citations.txt ───────┼─▶ bulk:clinvar ──┤
                 GWAS associations zip ───┼─▶ bulk:gwas ─────┼─▶ public/data/gwas.json.gz     (≈391k variant–trait groups + study metadata)
                 trait mappings ──────────┘   (+ Ensembl)    └─▶ public/data/papers.json.gz   (≈128k paper titles; LitVar for curated sites)
```

- **ClinVar screen:** keeps germline aggregate Pathogenic/Likely pathogenic (not conflicting), ≥1★ (with the `"no assertion criteria provided"` → 0★ fix), with an rsID and simple GRCh37 VCF alleles ≤50 bp. The browser matches each row with `matchSite` (VCF alleles are forward-strand; indel kind comes from the allele lengths) and interprets it with the same `clinicalFinding` as the curated tier. The full ClinGen table supplies inheritance. A verified warning (Weedon et al. 2021) precedes all hits, and each hit carries a false-positive limitation.
- **GWAS explorer:** keeps catalog rows with p < 5×10⁻⁸, a single rsID, a concrete effect allele, an OR/β value and one mapped trait. OR vs β is read from the CI text ("increase"/"decrease"/units ⇒ β). Rows are grouped per (current rsID, EFO URI). Alleles come from Ensembl GRCh37 (`allele_string`, ref first). The main alt is Ensembl's minor allele, or failing that the alt most often reported. Direction is expressed relative to the main alt; the lead association comes from the majority cluster; concordant publications and discordant associations are counted. Up to 25 PMIDs are kept per group. The domain comes from the catalog's EFO parent categories, plus a performance-trait regex.
- **Papers per allele:**
  - **ClinVar-cited:** the var_citations entries for that VariationID.
  - **GWAS papers:** every study in the group, with titles from the catalog's own study columns.
  - **LitVar2:** text-mined mentions for the rsID (curated sites only).

  Titles for non-catalog PMIDs come from PubMed esummary, cached per PMID.
- **Runtime:** the parse worker fetches the gz files from the same origin. It decompresses only if the gzip magic bytes are present, since some servers send `Content-Encoding: gzip`. It widens the parser's keep-set to all bulk rsIDs, screens both tiers, and returns only sites present in the file. The paper index loads lazily when a list is first opened.
- **Curated sites are excluded from the bulk tiers,** so they appear once, with the richer interpretation.

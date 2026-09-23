# Architecture

## Technical choices

| Choice | Why |
|---|---|
| **Static React + Vite app; analysis in the browser** | The strongest privacy guarantee is that genotypes never leave the device. With no backend, there is nothing to retain or breach. |
| **Web Worker parsing (with `fflate` for .zip)** | Raw files are 15–25 MB. Parsing off the main thread keeps the UI responsive, and only curated sites are kept. |
| **CSP `connect-src 'none'` in production** | Makes the "no network" promise enforceable, not just a policy. |
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
                └─ audit: AuditEntry[]           every drop/warning with reason
ParsedGenome → SiteMatch[] → Finding (clinical | gwas | composite | no-evidence) → InterventionAssessment → Report
```

Every record carries a `SourceVersion`. Adding sites, topics or interventions means **adding seed data only**: `pipeline/seeds/*.json`, then `npm run evidence:all`. No model or UI change is needed. A new source (e.g. PharmGKB, Europe PMC) adds a retrieval module that emits the same record types.

## Retrieval (`pipeline/fetch.ts`, `pipeline/literature.ts`)

- **Curated vs retrieved:** seeds choose *which* sites, trait groups and papers to use. Every *fact* (alleles, classifications, effect sizes, sample sizes, titles, DOIs, publication types) comes from the fetched source.
- **ClinVar:** only single-variant records whose dbSNP cross-reference is the exact rsID are kept. SNV alleles come from canonical SPDI; indels are matched by net length change. Reference-allele records (e.g. `c.1601=`) are dropped with an audit entry. Per-condition RCV classifications come from the VCV XML.
- **GWAS:** only associations with p < 5×10⁻⁸ that match the topic's EFO regex, and optionally its reported-trait regex, are kept. Multi-SNP haplotype and interaction associations are excluded. Study metadata (sample, ancestry) is fetched for the strongest 6 per site/topic.
- **Literature candidates:** two PubMed queries per topic, one design-filtered (MA/SR/RCT/guideline) and one gene–diet. Each record is classified by publication type and MeSH (`Humans` / `Animals`), with a text fallback flagged "not yet MeSH-indexed". It gets an in-vitro/mechanistic flag, a genotype × intervention keyword screen, and a regex-extracted sample size shown with its snippet.

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

- `tests/core.test.ts` (28 tests): both input formats, CRLF/BOM, VCF/CSV/empty/corrupt rejection, low call rate, discordant duplicates, forward/complement/palindromic/multi-allelic/mismatch/indel/merged/position cases, the ClinVar category ladder, GWAS strand and majority logic, contradictory sources, APOE, no-evidence topics, context flags, "no evidence-based personalized action", sensitive-result hiding, JSON export excluding raw data, and verification dropping fabricated quotes, animal-only supplements and missing sources.
- `scripts/smoke.ts`: headless Chrome against the production build. It checks that the report renders for both demos, that there are no console errors and zero external requests, and that delete works.

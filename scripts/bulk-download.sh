#!/usr/bin/env bash
# Downloads the bulk source files into pipeline/cache/bulk (≈1.5 GB unpacked; git-ignored).
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)/pipeline/cache/bulk"
mkdir -p "$D/gwas" && cd "$D"
curl -fRL --retry 3 -o variant_summary.txt.gz https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/variant_summary.txt.gz
curl -fRL --retry 3 -o var_citations.txt https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/var_citations.txt
curl -fRL --retry 3 -o gwas_associations.zip https://www.ebi.ac.uk/gwas/api/search/downloads/associations/v1.0.2
curl -fRL --retry 3 -o gwas_trait_mappings.tsv https://www.ebi.ac.uk/gwas/api/search/downloads/trait_mappings
curl -fRL --retry 3 -A "locus-evidence-pipeline" -o ctd_chem_gene_ixns.tsv.gz https://ctdbase.org/reports/CTD_chem_gene_ixns.tsv.gz
unzip -o -q gwas_associations.zip -d gwas
echo "bulk sources ready in $D"

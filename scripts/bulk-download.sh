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
# 1000 Genomes phase 3 sites (2 GB): exact allele frequencies for ClinVar variants
curl -fRL --retry 3 -o 1kg_sites.vcf.gz https://1000genomes.s3.amazonaws.com/release/20130502/ALL.wgs.phase3_shapeit2_mvncall_integrated_v5b.20130502.sites.vcf.gz
unzip -o -q gwas_associations.zip -d gwas
echo "bulk sources ready in $D"

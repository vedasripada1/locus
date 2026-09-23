// Stage 1 — source retrieval. Pulls records for the curated seed list from
// dbSNP, ClinVar, ClinGen and the GWAS Catalog and normalises them. It makes
// no interpretive claims: every value below is copied from a source response.
import { get, readJson, writeJson, today } from "./lib/http";
import type { AuditEntry, ClinGenValidity, ClinVarRecord, RcvClassification, GwasAssociation, ReviewStars, SourceVersion, VariantSite } from "../src/core/types";

interface SeedSite { rsid: string; gene: string; label: string; domain: VariantSite["domain"]; clinvar?: boolean; sensitive?: boolean; note?: string }
interface SeedTopic { id: string; label: string; domain: VariantSite["domain"]; rsids: string[]; traitPattern: string; reportedPattern?: string; phrase: string; description: string }
const seeds = readJson<{ sites: SeedSite[]; topics: SeedTopic[] }>("pipeline/seeds/variants.json");

const GW_SIG_EXP = -8; // p < 5e-8
const STUDIES_PER_GROUP = 6; // study metadata fetched for the strongest N per (topic, rsid)
const audit: AuditEntry[] = [];
const sources: SourceVersion[] = [];

// ─── dbSNP ─────────────────────────────────────────────────────────────────
async function fetchSite(seed: SeedSite): Promise<VariantSite | null> {
  const id = seed.rsid.slice(2);
  const url = `https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/${id}`;
  const c = await get<any>(url);
  const d = c.body;
  if (!d.primary_snapshot_data) {
    audit.push({ stage: "fetch", subject: seed.rsid, outcome: "dropped", detail: "No current dbSNP record (withdrawn or merged)." });
    return null;
  }
  const places: any[] = d.primary_snapshot_data.placements_with_allele;
  const onAsm = (re: RegExp) =>
    places.find((p) => p.seq_id.startsWith("NC_") && p.placement_annot.seq_id_traits_by_assembly.some((a: any) => re.test(a.assembly_name)));
  const p38 = onAsm(/^GRCh38/);
  const p37 = onAsm(/^GRCh37/);
  if (!p38) {
    audit.push({ stage: "fetch", subject: seed.rsid, outcome: "dropped", detail: "No GRCh38 chromosome placement in dbSNP." });
    return null;
  }
  const spdis = p38.alleles.map((a: any) => a.allele.spdi);
  const ref: string = spdis[0].deleted_sequence;
  const alts: string[] = [...new Set<string>(spdis.map((s: any) => s.inserted_sequence).filter((s: string) => s !== ref))];
  let kind: VariantSite["kind"] = "other";
  if (ref.length === 1 && alts.every((a) => a.length === 1)) kind = "snv";
  else if (alts.length === 1 && alts[0].length < ref.length) kind = "deletion";
  else if (alts.length === 1 && alts[0].length > ref.length) kind = "insertion";
  const chromFromAcc = (acc: string) => {
    const n = Number(acc.match(/NC_0+(\d+)\./)?.[1]);
    return n === 23 ? "X" : n === 24 ? "Y" : n === 12920 ? "MT" : String(n);
  };
  const pos = (p: any) => (p ? p.alleles[0].allele.spdi.position + 1 : null);
  const src: SourceVersion = { source: "dbSNP", version: `build ${d.last_update_build_id}`, retrievedAt: c.retrievedAt.slice(0, 10), url: `https://www.ncbi.nlm.nih.gov/snp/${seed.rsid}` };
  const aliases: string[] = (d.dbsnp1_merges ?? []).map((m: any) => `rs${m.merged_rsid}`);
  // Main alternate allele = the alt with the largest summed allele count across dbSNP frequency studies.
  const counts = new Map<string, number>();
  for (const ann of d.primary_snapshot_data.allele_annotations ?? []) {
    for (const f of ann.frequency ?? []) {
      const a = f.observation?.inserted_sequence;
      if (a != null && a !== f.observation?.deleted_sequence) counts.set(a, (counts.get(a) ?? 0) + (f.allele_count ?? 0));
    }
  }
  const ranked = alts.filter((a) => (counts.get(a) ?? 0) > 0).sort((x, y) => (counts.get(y) ?? 0) - (counts.get(x) ?? 0));
  const mainAlt = ranked[0] ?? alts[0];
  if (kind === "other") audit.push({ stage: "fetch", subject: seed.rsid, outcome: "warning", detail: `Complex allele set ${ref}>${alts.join(",")}; genotype matching disabled.` });
  return {
    rsid: seed.rsid, aliases, gene: seed.gene, label: seed.label, domain: seed.domain, sensitive: !!seed.sensitive, curatorNote: seed.note,
    chrom: chromFromAcc(p38.seq_id), pos37: pos(p37), pos38: pos(p38),
    ref: ref || "-", alts: alts.map((a) => a || "-"), mainAlt: mainAlt || "-", kind, source: src,
  };
}

// ─── ClinVar ───────────────────────────────────────────────────────────────
function stars(status: string): ReviewStars {
  const s = status.toLowerCase();
  if (s.includes("practice guideline")) return 4;
  if (s.includes("expert panel")) return 3;
  if (s.includes("multiple submitters, no conflicts")) return 2;
  if (s.includes("criteria provided")) return 1;
  return 0;
}

const decode = (x: string) => x.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Per-condition (RCV) classifications from the full VCV XML record. */
async function fetchRcvs(uid: string): Promise<RcvClassification[]> {
  const c = await get<string>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=clinvar&id=${uid}&rettype=vcv&is_variationid`, "text");
  const out: RcvClassification[] = [];
  for (const m of c.body.matchAll(/<RCVAccession ([^>]*)>([\s\S]*?)<\/RCVAccession>/g)) {
    const [, attrs, inner] = m;
    const title = decode(attrs.match(/Title="([^"]*)"/)?.[1] ?? "");
    const acc = attrs.match(/Accession="([^"]*)"/)?.[1];
    const ver = attrs.match(/Version="([^"]*)"/)?.[1];
    const classification = decode(inner.match(/<Description[^>]*>([^<]*)</)?.[1] ?? "").trim();
    const reviewStatus = decode(inner.match(/<ReviewStatus>([^<]*)</)?.[1] ?? "").trim();
    if (!acc || !classification) continue;
    out.push({ rcv: `${acc}.${ver}`, condition: title.split(" AND ").slice(1).join(" AND ") || "not specified", classification, reviewStatus, stars: stars(reviewStatus) });
  }
  return out;
}

async function fetchClinVar(site: VariantSite, clinvarVersion: string): Promise<ClinVarRecord[]> {
  const num = site.rsid.slice(2);
  const s = await get<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&term=${site.rsid}&retmode=json&retmax=50`);
  const ids: string[] = s.body.esearchresult.idlist;
  if (!ids.length) return [];
  const sum = await get<any>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&id=${ids.join(",")}&retmode=json`);
  const out: ClinVarRecord[] = [];
  for (const id of ids) {
    const r = sum.body.result[id];
    // Only single-variant records whose dbSNP cross-reference is exactly this rsID.
    if (!r || r.variation_set?.length !== 1) continue;
    const v = r.variation_set[0];
    if (!v.variation_xrefs.some((x: any) => x.db_source === "dbSNP" && x.db_id === num)) continue;
    const [, , del, ins] = (v.canonical_spdi ?? "").split(":");
    let alt: string | undefined;
    if (site.kind === "snv") alt = ins;
    else {
      // Indels: match on net length change, since SPDI normalisation differs between records.
      const len = (a: string) => (a === "-" ? 0 : a.length);
      const delta = (ins ?? "").length - (del ?? "").length;
      alt = delta === 0 ? undefined : site.alts.find((a) => len(a) - len(site.ref) === delta);
      if (alt && site.kind === "other") {
        site.kind = delta < 0 ? "deletion" : "insertion";
        site.curatorNote = `dbSNP lists several alleles here (${site.ref}>${site.alts.join(",")}); consumer I/D calls are read as the ClinVar allele ${del}>${ins}.`;
        site.alts = [alt, ...site.alts.filter((a) => a !== alt)];
        site.mainAlt = alt;
        const stale = audit.findIndex((a) => a.subject === site.rsid && a.detail.includes("matching disabled"));
        if (stale >= 0) audit.splice(stale, 1);
        audit.push({ stage: "fetch", subject: site.rsid, outcome: "warning", detail: site.curatorNote });
      }
    }
    if (!alt || (site.kind === "snv" && !site.alts.includes(alt))) {
      audit.push({ stage: "fetch", subject: `${r.accession} (${site.rsid})`, outcome: "dropped", detail: `ClinVar allele ${del}>${ins} could not be matched to dbSNP alleles.` });
      continue;
    }
    const g = r.germline_classification ?? {};
    if (!g.description) continue;
    out.push({
      kind: "clinvar", id: r.accession_version, rsid: site.rsid, title: r.title, altAllele: alt,
      classification: g.description, reviewStatus: g.review_status, stars: stars(g.review_status ?? ""),
      conflicting: /conflicting/i.test(g.description) || /conflicting/i.test(g.review_status ?? ""),
      conditions: [...new Set<string>((g.trait_set ?? []).map((t: any) => t.trait_name))].filter((n) => n && !/^(not provided|not specified|see cases)$/i.test(n)),
      rcvs: await fetchRcvs(r.uid),
      lastEvaluated: g.last_evaluated ? g.last_evaluated.slice(0, 10).replace(/\//g, "-") : null,
      url: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${r.uid}/`,
      source: { source: "ClinVar", version: `${r.accession_version} (ClinVar updated ${clinvarVersion})`, retrievedAt: sum.retrievedAt.slice(0, 10), url: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${r.uid}/` },
    });
  }
  return out;
}

// ─── ClinGen ───────────────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchClinGen(genes: Set<string>): Promise<ClinGenValidity[]> {
  const url = "https://search.clinicalgenome.org/kb/gene-validity/download";
  const c = await get<string>(url, "text");
  const lines = c.body.split(/\r?\n/);
  const created = lines.find((l) => l.includes("FILE CREATED"))?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown";
  const src: SourceVersion = { source: "ClinGen", version: `Gene-Disease Validity export ${created}`, retrievedAt: c.retrievedAt.slice(0, 10), url: "https://search.clinicalgenome.org/kb/gene-validity" };
  sources.push(src);
  return lines
    .map(parseCsvLine)
    .filter((r) => r.length >= 9 && genes.has(r[0]) && !/obsolete/i.test(r[2]))
    .map((r) => ({ kind: "clingen" as const, gene: r[0], disease: r[2], mondo: r[3], moi: r[4], classification: r[6], url: r[7], source: src }));
}

// ─── GWAS Catalog ──────────────────────────────────────────────────────────
async function fetchGwas(topic: SeedTopic, rsid: string, release: SourceVersion): Promise<GwasAssociation[]> {
  const all: any[] = [];
  for (let page = 0; ; page++) {
    const c = await get<any>(`https://www.ebi.ac.uk/gwas/rest/api/v2/associations?rs_id=${rsid}&size=200&page=${page}`);
    all.push(...(c.body._embedded?.associations ?? []));
    if (page + 1 >= (c.body.page?.totalPages ?? 1)) break;
  }
  const re = new RegExp(topic.traitPattern, "i");
  const hits = all
    .filter((a) => !a.multi_snp_haplotype && !a.snp_interaction)
    .filter((a) => a.pvalue_exponent < GW_SIG_EXP || (a.pvalue_exponent === GW_SIG_EXP && a.pvalue_mantissa < 5))
    .filter((a) => a.efo_traits.some((t: any) => re.test(t.efo_trait)))
    .filter((a) => !topic.reportedPattern || a.reported_trait.some((r: string) => new RegExp(topic.reportedPattern!, "i").test(r)))
    .sort((a, b) => a.pvalue_exponent - b.pvalue_exponent || a.pvalue_mantissa - b.pvalue_mantissa);
  const out: GwasAssociation[] = [];
  for (const [i, a] of hits.entries()) {
    let study: any = null;
    if (i < STUDIES_PER_GROUP) study = (await get<any>(`https://www.ebi.ac.uk/gwas/rest/api/v2/studies/${a.accession_id}`)).body;
    const efo = a.efo_traits.find((t: any) => re.test(t.efo_trait));
    const eff = a.snp_allele?.find((s: any) => s.rs_id === rsid)?.effect_allele ?? "?";
    out.push({
      kind: "gwas", id: String(a.association_id), rsid, effectAllele: String(eff).toUpperCase(),
      traitLabel: topic.label, efoId: efo.efo_id, reportedTrait: a.reported_trait.join("; "),
      pValue: `${a.pvalue_mantissa}e${a.pvalue_exponent}`, pExponent: a.pvalue_exponent,
      orValue: typeof a.or_value === "number" ? a.or_value : a.or_value ? Number(a.or_value) || null : null,
      beta: a.beta && a.beta !== "-" ? a.beta : null,
      ci: a.range && a.range !== "-" ? a.range : null,
      riskFrequency: a.risk_frequency && a.risk_frequency !== "NR" ? a.risk_frequency : null,
      studyAccession: a.accession_id, pmid: String(a.pubmed_id), firstAuthor: a.first_author,
      initialSampleSize: study?.initial_sample_size ?? "",
      ancestry: study?.discovery_ancestry ?? [],
      url: `https://www.ebi.ac.uk/gwas/studies/${a.accession_id}`,
      paperUrl: `https://pubmed.ncbi.nlm.nih.gov/${a.pubmed_id}/`,
      source: { ...release, url: `https://www.ebi.ac.uk/gwas/rest/api/v2/associations/${a.association_id}` },
    });
  }
  return out;
}

async function main() {
  console.log("dbSNP…");
  const sites: VariantSite[] = [];
  for (const s of seeds.sites) {
    const site = await fetchSite(s);
    if (site) sites.push(site);
    process.stdout.write(".");
  }
  sources.push({ source: "dbSNP", version: sites[0]?.source.version ?? "?", retrievedAt: today(), url: "https://api.ncbi.nlm.nih.gov/variation/v0/" });

  console.log("\nClinVar…");
  const info = await get<any>("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?db=clinvar&retmode=json");
  const cvVersion = info.body.einforesult.dbinfo[0].lastupdate;
  sources.push({ source: "ClinVar", version: `last updated ${cvVersion}`, retrievedAt: info.retrievedAt.slice(0, 10), url: "https://www.ncbi.nlm.nih.gov/clinvar/" });
  const clinvar: ClinVarRecord[] = [];
  for (const s of seeds.sites.filter((x) => x.clinvar)) {
    const site = sites.find((x) => x.rsid === s.rsid);
    if (site) clinvar.push(...(await fetchClinVar(site, cvVersion)));
    process.stdout.write(".");
  }

  console.log("\nClinGen…");
  const clingen = await fetchClinGen(new Set(sites.filter((s) => s.domain === "clinical").map((s) => s.gene)));

  console.log("GWAS Catalog…");
  const meta = await get<any>("https://www.ebi.ac.uk/gwas/rest/api/v2/metadata");
  const release: SourceVersion = { source: "GWAS Catalog", version: `data release ${meta.body.data_release_date} (API ${meta.body.version}, EFO ${meta.body.efo_version})`, retrievedAt: meta.retrievedAt.slice(0, 10), url: "https://www.ebi.ac.uk/gwas/" };
  sources.push(release);
  const gwas: GwasAssociation[] = [];
  for (const t of seeds.topics) {
    for (const rsid of t.rsids) {
      if (!sites.some((s) => s.rsid === rsid)) continue;
      let got: GwasAssociation[] = [];
      try {
        got = await fetchGwas(t, rsid, release);
      } catch (e) {
        audit.push({ stage: "fetch", subject: `GWAS ${t.id} ${rsid}`, outcome: "warning", detail: `GWAS Catalog request failed (${(e as Error).message}); no associations included for this site.` });
      }
      gwas.push(...got);
      console.log(`  ${t.id} ${rsid}: ${got.length} genome-wide significant`);
    }
  }
  writeJson("pipeline/out/variants.json", { sites, clinvar, clingen, gwas, sources, audit, topics: seeds.topics });
  console.log(`wrote pipeline/out/variants.json: ${sites.length} sites, ${clinvar.length} ClinVar, ${clingen.length} ClinGen, ${gwas.length} GWAS`);
}

main().catch((e) => { console.error(e); process.exit(1); });

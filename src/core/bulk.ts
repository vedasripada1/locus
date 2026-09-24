// Bulk tiers (genome-wide ClinVar P/LP screen and grouped GWAS Catalog associations).
// Data files are produced by pipeline/bulk/* and served same-origin from /data/*.json.gz.
// Matching reuses matchSite(); ClinVar interpretation reuses clinicalFinding().
import { matchSite, countAllele, orientAllele } from "./match";
import { clinicalFinding } from "./interpret";
import type { ClinicalFinding, ClinGenValidity, ClinVarRecord, EvidenceStrength, ParsedGenome, ReviewStars, SiteMatch, SourceVersion, VariantSite } from "./types";

// ─── File formats (compact tuples) ─────────────────────────────────────────

/** [rsNum, chrom, pos37, ref, alt, sigIdx, stars, geneIdx, condIdx[], variationId, lastEvaluated, name] */
export type CvRow = [number, string, number, string, string, number, number, number, number[], number, string, string];
export interface BulkClinVarFile { version: string; retrievedAt: string; genes: string[]; conditions: string[]; sigs: string[]; rows: CvRow[]; cites: Record<string, number[]> }

/** [rsid, traitIdx, leadAllele, leadForward, value, kind(0 OR,1 β), sign, ci, p, leadPmid, sampleIdx, concordantPubs, discordantAssocs, nAssocs, pmids[], how] */
export type GwRow = [string, number, string, string, number, 0 | 1, 1 | -1 | 0, string, string, number, number, number, number, number, number[], string];
export interface BulkGwasFile {
  version: string; retrievedAt: string;
  traits: [label: string, uri: string, categories: string, domain: BulkDomain][];
  sites: Record<string, [chrom: string, pos37: number | null, ref: string, mainAlt: string, alts: string, gene: string]>;
  samples: string[]; groups: GwRow[];
  studies: Record<string, [firstAuthor: string, year: string, journal: string, title: string]>;
  aliases: Record<string, string>;
}
export type BulkDomain = "disease" | "metabolism" | "performance" | "other";

// ─── Results ────────────────────────────────────────────────────────────────

export interface BulkGwasHit {
  rsid: string; gene: string; trait: string; traitUri: string; categories: string; domain: BulkDomain;
  genotype: string; forwardGenotype: string; orientation: SiteMatch["orientation"];
  effectAllele: string; effectForward: string | null; copies: number | null;
  value: number; kind: "OR" | "beta"; direction: "increase" | "decrease" | "unclear"; ci: string; p: string;
  leadPmid: number; sample: string; concordantPubs: number; discordant: number; nAssocs: number; pmids: number[];
  strength: EvidenceStrength; notes: string[];
}

export interface BulkResult {
  clinvar: {
    version: string; tested: number; notCarried: number; noCall: number; carried: ClinicalFinding[]; cites: Record<string, number[]>;
    /** Coverage for search: readable ClinVar P/LP sites per gene and per condition, as [tested, carried]. */
    byGene: Record<string, [number, number]>; byCondition: Record<string, [number, number]>;
  };
  gwas: { version: string; tested: number; hits: BulkGwasHit[]; studies: BulkGwasFile["studies"] };
}

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * Fetch a same-origin .json.gz data file. Some static servers send it with
 * Content-Encoding: gzip (the browser then inflates it), others as raw bytes,
 * so decompress only when the gzip magic bytes (1f 8b) are present.
 */
export async function loadGz<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gz
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

export function bulkRsids(cv: BulkClinVarFile | null, gw: BulkGwasFile | null): string[] {
  const s = new Set<string>();
  for (const r of cv?.rows ?? []) s.add(`rs${r[0]}`);
  for (const k of Object.keys(gw?.sites ?? {})) s.add(k);
  for (const k of Object.keys(gw?.aliases ?? {})) s.add(k);
  return [...s];
}

// ─── ClinVar screen ─────────────────────────────────────────────────────────

const STAR_LABEL = ["no assertion criteria provided", "criteria provided, single submitter", "criteria provided, multiple submitters, no conflicts", "reviewed by expert panel", "practice guideline"];

function cvSite(r: CvRow, gene: string, src: SourceVersion): VariantSite {
  const [rs, chrom, pos, ref, alt] = r;
  const kind = ref.length === 1 && alt.length === 1 ? "snv" : alt.length < ref.length && ref.startsWith(alt) ? "deletion" : ref.length < alt.length && alt.startsWith(ref) ? "insertion" : "other";
  return { rsid: `rs${rs}`, aliases: [], gene, chrom, pos37: pos, pos38: null, ref, alts: [alt], mainAlt: alt, kind, domain: "clinical", label: r[11].replace(/^[^(]*\(([^)]+)\):/, "$1 ").slice(0, 80) || `${gene} rs${rs}`, sensitive: false, source: src };
}

export function screenClinVar(genome: ParsedGenome, f: BulkClinVarFile, clingen: ClinGenValidity[]): BulkResult["clinvar"] {
  const src: SourceVersion = { source: "ClinVar", version: `variant_summary ${f.version}`, retrievedAt: f.retrievedAt, url: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/" };
  const out: BulkResult["clinvar"] = { version: f.version, tested: 0, notCarried: 0, noCall: 0, carried: [], cites: {}, byGene: {}, byCondition: {} };
  const tally = (m: Record<string, [number, number]>, k: string, hit: boolean) => { const t = (m[k] ??= [0, 0]); t[0]++; if (hit) t[1]++; };
  const byGene = new Map<string, ClinGenValidity[]>();
  for (const g of clingen) (byGene.get(g.gene) ?? byGene.set(g.gene, []).get(g.gene)!).push(g);
  for (const r of f.rows) {
    if (!genome.calls.has(`rs${r[0]}`)) continue;
    const gene = f.genes[r[7]];
    const site = cvSite(r, gene, src);
    const m = matchSite(genome, site);
    if (m.status === "no-call") { out.noCall++; continue; }
    if (m.status !== "matched") continue;
    out.tested++;
    const copies = countAllele(m, r[4]);
    tally(out.byGene, gene, !!copies);
    for (const c of r[8]) tally(out.byCondition, f.conditions[c], !!copies);
    if (!copies) { out.notCarried++; continue; }
    const rec: ClinVarRecord = {
      kind: "clinvar", id: `VariationID ${r[9]}`, rsid: site.rsid, title: r[11], altAllele: r[4], classification: f.sigs[r[5]],
      reviewStatus: STAR_LABEL[r[6]] ?? "", stars: r[6] as ReviewStars, conflicting: false,
      conditions: r[8].map((i) => f.conditions[i]), rcvs: [], lastEvaluated: r[10] || null,
      url: `https://www.ncbi.nlm.nih.gov/clinvar/variation/${r[9]}/`, source: src,
    };
    const finding = clinicalFinding(m, rec, { clingen: byGene.get(gene) ?? [] } as never);
    finding.limitations.unshift("Genome-wide screen: this very rare variant was reported by a consumer chip. Most such calls are false positives; see the warning above.");
    out.carried.push(finding);
    const c = f.cites[String(r[9])];
    if (c) out.cites[String(r[9])] = c;
  }
  out.carried.sort((a, b) => b.record.stars - a.record.stars || a.match.site.gene.localeCompare(b.match.site.gene));
  return out;
}

// ─── GWAS explorer ──────────────────────────────────────────────────────────

export function strengthOf(concordantPubs: number, discordant: number, nAssocs: number): EvidenceStrength {
  if (discordant > 0 && discordant >= Math.max(1, (nAssocs - discordant) * 0.25)) return "conflicting";
  return concordantPubs >= 3 ? "strong" : concordantPubs === 2 ? "moderate" : concordantPubs === 1 ? "limited" : "insufficient";
}

export function screenGwas(genome: ParsedGenome, f: BulkGwasFile, exclude: Set<string>): BulkResult["gwas"] {
  const src: SourceVersion = { source: "GWAS Catalog", version: `associations download ${f.version}`, retrievedAt: f.retrievedAt, url: "https://www.ebi.ac.uk/gwas/" };
  const reverseAlias = new Map<string, string[]>();
  for (const [old, cur] of Object.entries(f.aliases)) (reverseAlias.get(cur) ?? reverseAlias.set(cur, []).get(cur)!).push(old);
  const matches = new Map<string, SiteMatch | null>();
  const siteMatch = (rsid: string): SiteMatch | null => {
    if (matches.has(rsid)) return matches.get(rsid)!;
    const s = f.sites[rsid];
    const aliases = reverseAlias.get(rsid) ?? [];
    let m: SiteMatch | null = null;
    if (s && !exclude.has(rsid) && [rsid, ...aliases].some((id) => genome.calls.has(id))) {
      const site: VariantSite = { rsid, aliases, gene: s[5], chrom: s[0], pos37: s[1], pos38: null, ref: s[2], alts: s[4].split(","), mainAlt: s[3], kind: "snv", domain: "disease", label: `${s[5] || "rs"} ${rsid}`, sensitive: false, source: src };
      m = matchSite(genome, site);
    }
    matches.set(rsid, m);
    return m;
  };
  const hits: BulkGwasHit[] = [];
  const studies: BulkGwasFile["studies"] = {};
  for (const g of f.groups) {
    const m = siteMatch(g[0]);
    if (!m || m.status !== "matched") continue;
    const [label, uri, categories, domain] = f.traits[g[1]];
    const o = orientAllele(g[2], m.site);
    const ambiguous = o.how === "ambiguous" || m.orientation === "ambiguous-palindromic";
    const copies = ambiguous || !o.allele ? null : countAllele(m, o.allele);
    const notes = [...m.notes];
    if (ambiguous) notes.push("Strand-ambiguous (A/T or C/G) site: effect-allele copies are not counted.");
    if (o.how === "complemented") notes.push(`The study reported ${g[2]} on the opposite strand; aligned to ${o.allele}.`);
    if (o.how === "unresolvable") notes.push(`Reported allele ${g[2]} does not match this site's alleles; not counted.`);
    hits.push({
      rsid: g[0], gene: m.site.gene, trait: label, traitUri: uri, categories, domain,
      genotype: m.call!.raw, forwardGenotype: m.forwardAlleles.join(""), orientation: m.orientation,
      effectAllele: g[2], effectForward: o.allele, copies, value: g[4], kind: g[5] === 0 ? "OR" : "beta",
      direction: g[6] === 1 ? "increase" : g[6] === -1 ? "decrease" : "unclear", ci: g[7], p: g[8], leadPmid: g[9], sample: f.samples[g[10]],
      concordantPubs: g[11], discordant: g[12], nAssocs: g[13], pmids: g[14], strength: strengthOf(g[11], g[12], g[13]), notes,
    });
    for (const p of g[14]) if (f.studies[p]) studies[p] = f.studies[p];
  }
  const tested = [...matches.values()].filter((m) => m?.status === "matched").length;
  return { version: f.version, tested, hits, studies };
}

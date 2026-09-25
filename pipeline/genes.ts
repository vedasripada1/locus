// Stage 1c — gene guide.
// Verifies the curated gene guide (pipeline/seeds/genes.json) before anything reaches the app:
//  1. the site exists in dbSNP and the curated allele is one of its forward-strand alleles;
//  2. for coding variants, the curated amino acid matches Ensembl VEP (GRCh37) for that allele;
//  3. every quote is found verbatim in its PubMed abstract or web page;
//  4. every number in a plain-language text appears in one of the entry's verified quotes.
// Adds 1000 Genomes phase 3 allele frequencies (Ensembl) and, when the bulk GWAS Catalog
// download is present, the number of genome-wide significant papers per site.
// Anything that fails is dropped and logged. Output: pipeline/out/genes.json
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { join } from "node:path";
import { get, readJson, writeJson, today, ROOT } from "./lib/http";
import { fetchRecords, stripTags } from "./lib/pubmed";
import { fetchSite } from "./fetch";
import { cite, numbers, verifyQuoted } from "./build";
import type { AuditEntry, GeneGuide, GeneGuideEntry, GeneGuideSite, SourceVersion, SourcedQuote, VariantSite } from "../src/core/types";

type Ref = { pmid?: string; url?: string };
interface SeedQuote { ref: Ref; value: string; quote: string }
interface SeedSite { rsid: string; allele: string; alleleName: string; aa?: string }
interface SeedEntry extends Omit<GeneGuideEntry, "sites" | "evidence"> { sites: SeedSite[]; evidence: SeedQuote[] }
interface Seed { genes: SeedEntry[]; unsupported: { rsid: string; gene: string; claim: string }[]; notes: { id: string; title: string; text: string; evidence: SeedQuote[] }[] }

const refKey = (r: Ref) => (r.pmid ? `pmid:${r.pmid}` : `url:${r.url}`);

/** Amino acid(s) Ensembl VEP gives each forward-strand allele (canonical transcripts first). */
export async function vepAminoAcids(rsid: string): Promise<Record<string, string[]>> {
  const c = await get<any[]>(`https://grch37.rest.ensembl.org/vep/human/id/${rsid}?content-type=application/json&canonical=1`);
  const out: Record<string, string[]> = {};
  for (const r of c.body) {
    if (!/^(\d+|X|Y)$/.test(r.seq_region_name)) continue;
    for (const t of r.transcript_consequences ?? []) {
      if (!t.amino_acids || !t.variant_allele) continue;
      const [refAa, altAa = refAa] = String(t.amino_acids).split("/");
      (out[t.variant_allele] ??= []).push(altAa);
      // The reference allele's amino acid, keyed by the reference base from allele_string.
      const refBase = String(r.allele_string).split("/")[0];
      (out[refBase] ??= []).push(refAa);
    }
  }
  return out;
}

/** 1000 Genomes phase 3 allele frequencies per population, from Ensembl. */
async function frequencies(rsid: string): Promise<Record<string, Record<string, number>> | null> {
  try {
    const c = await get<any>(`https://grch37.rest.ensembl.org/variation/human/${rsid}?pops=1&content-type=application/json`);
    const out: Record<string, Record<string, number>> = {};
    for (const p of c.body.populations ?? []) {
      const m = String(p.population).match(/^1000GENOMES:phase_3:(ALL|AFR|AMR|EAS|EUR|SAS)$/);
      if (m) (out[p.allele] ??= {})[m[1]] = p.frequency;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** rsid → { distinct PubMed IDs, most frequent mapped traits } from the bulk GWAS Catalog files, if downloaded. */
async function gwasCounts(rsids: Set<string>): Promise<Map<string, { pubs: number; traits: string[] }> | null> {
  const dir = join(ROOT, "pipeline/cache/bulk/gwas");
  if (!existsSync(dir)) return null;
  const pubs = new Map<string, Set<string>>(), traits = new Map<string, Map<string, number>>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsv"))) {
    let head: string[] | null = null, iP = 0, iS = 0, iT = 0, iV = 0;
    for await (const line of createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Infinity })) {
      const c = line.split("\t");
      if (!head) { head = c; iP = c.indexOf("PUBMEDID"); iS = c.indexOf("SNPS"); iT = c.indexOf("MAPPED_TRAIT"); iV = c.indexOf("PVALUE_MLOG"); continue; }
      if (c.length <= iT || Number(c[iV]) < 8 - Math.log10(5)) continue; // p < 5e-8
      for (const s of c[iS].split(/[ ;x,]+/)) {
        if (!rsids.has(s)) continue;
        (pubs.get(s) ?? pubs.set(s, new Set()).get(s)!).add(c[iP]);
        const t = traits.get(s) ?? traits.set(s, new Map()).get(s)!;
        t.set(c[iT], (t.get(c[iT]) ?? 0) + 1);
      }
    }
  }
  const out = new Map<string, { pubs: number; traits: string[] }>();
  for (const s of rsids) out.set(s, { pubs: pubs.get(s)?.size ?? 0, traits: [...(traits.get(s) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t) });
  return out;
}

/**
 * Exact 1000 Genomes phase 3 frequencies from the local sites VCF (pipeline/cache/bulk/1kg_sites.vcf.gz),
 * keyed "chrom:pos37" → allele → population → frequency. The reference allele gets 1 − Σ ALT.
 */
async function kgFrequencies(sites: VariantSite[]): Promise<Map<string, Record<string, Record<string, number>>> | null> {
  const file = join(ROOT, "pipeline/cache/bulk/1kg_sites.vcf.gz");
  if (!existsSync(file)) return null;
  const want = new Set(sites.filter((s) => s.pos37).map((s) => `${s.chrom}:${s.pos37}`));
  const out = new Map<string, Record<string, Record<string, number>>>();
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.charCodeAt(0) === 35) continue;
    const t1 = line.indexOf("\t"), t2 = line.indexOf("\t", t1 + 1);
    const key = `${line.slice(0, t1)}:${line.slice(t1 + 1, t2)}`;
    if (!want.has(key)) continue;
    const c = line.split("\t", 8);
    const alts = c[4].split(",");
    const info = Object.fromEntries(c[7].split(";").map((x) => x.split("=")));
    const rec = out.get(key) ?? {};
    for (const pop of ["ALL", "AFR", "AMR", "EAS", "EUR", "SAS"]) {
      const afs = String(info[pop === "ALL" ? "AF" : `${pop}_AF`] ?? "").split(",").map(Number);
      if (afs.length !== alts.length || afs.some(Number.isNaN)) continue;
      alts.forEach((a, i) => ((rec[a] ??= {})[pop] = (rec[a]?.[pop] ?? 0) + afs[i]));
      (rec[c[3]] ??= {})[pop] = Math.max(0, 1 - afs.reduce((x, y) => x + y, 0));
    }
    out.set(key, rec);
  }
  return out;
}

async function sourceTexts(refs: Ref[]): Promise<Map<string, { text: string; source: SourceVersion; citation: string }>> {
  const out = new Map<string, { text: string; source: SourceVersion; citation: string }>();
  const pmids = [...new Set(refs.filter((r) => r.pmid).map((r) => r.pmid!))];
  for (const r of await fetchRecords(pmids)) out.set(`pmid:${r.pmid}`, { text: `${r.title}\n${r.abstract}`, source: r.source, citation: cite(r) });
  for (const url of new Set(refs.filter((r) => r.url).map((r) => r.url!))) {
    try {
      const c = await get<string>(url, "text");
      const title = c.body.match(/<title>([^<]*)/)?.[1]?.trim() ?? url;
      out.set(`url:${url}`, { text: stripTags(c.body), citation: title.replace(/\s*[:|]\s*MedlinePlus.*$/, " (MedlinePlus)"),
        source: { source: "Web", version: "page", retrievedAt: c.retrievedAt.slice(0, 10), url } });
    } catch (e) { console.warn(`  could not fetch ${url}: ${(e as Error).message}`); }
  }
  return out;
}

function verifyQuotes(subject: string, qs: SeedQuote[], texts: Awaited<ReturnType<typeof sourceTexts>>, audit: AuditEntry[]): SourcedQuote[] | null {
  const out: SourcedQuote[] = [];
  for (const q of qs) {
    const src = texts.get(refKey(q.ref));
    const err = src ? verifyQuoted(q, src.text) : "source could not be retrieved";
    if (err) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: err }); return null; }
    out.push({ value: q.value, quote: q.quote, source: src!.source, citation: src!.citation });
  }
  return out;
}

/** Digits that are part of names, not quantities: omega-3, ε4, ALDH2*2, 23andMe, 25(OH)D. */
const NAME_TOKENS = /omega-\d|ε\d|\*\d|23andMe|25\(OH\)D/gi;

/** Every number in the plain texts must appear in a verified quote of the same entry (or in its own names). */
export function orphanNumbers(texts: (string | undefined)[], quotes: { quote: string }[], names: string[] = []): number[] {
  const allowed = new Set([...quotes, ...names.map((n) => ({ quote: n }))].flatMap((q) => numbers(q.quote.replace(NAME_TOKENS, ""))));
  return texts.flatMap((t) => (t ? numbers(t.replace(NAME_TOKENS, "")) : [])).filter((n) => !allowed.has(n));
}

async function guideSite(s: SeedSite, gene: string, subject: string, audit: AuditEntry[], gwas: Awaited<ReturnType<typeof gwasCounts>>, kg: Map<string, Record<string, Record<string, number>>> | null): Promise<GeneGuideSite | null> {
  const site = await fetchSite({ rsid: s.rsid, gene, label: `${gene} ${s.alleleName}`, domain: "metabolism" }) as VariantSite | null;
  if (!site) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: `${s.rsid}: no dbSNP record.` }); return null; }
  if (![site.ref, ...site.alts].includes(s.allele)) {
    audit.push({ stage: "verify", subject, outcome: "dropped", detail: `${s.rsid}: allele ${s.allele} is not a forward-strand allele in dbSNP (${site.ref}>${site.alts.join(",")}).` });
    return null;
  }
  if (s.aa) {
    const aas = (await vepAminoAcids(s.rsid))[s.allele] ?? [];
    if (!aas.includes(s.aa)) {
      audit.push({ stage: "verify", subject, outcome: "dropped", detail: `${s.rsid}: Ensembl VEP gives ${s.allele} → ${aas.join("/") || "no amino acid"}, not ${s.aa}.` });
      return null;
    }
  }
  const fromVcf = kg?.get(`${site.chrom}:${site.pos37}`)?.[s.allele];
  const freq = fromVcf ?? (await frequencies(s.rsid))?.[s.allele] ?? null;
  const g = gwas?.get(s.rsid);
  return { ...s, site, freq, gwasPubs: g?.pubs ?? null, gwasTraits: g?.traits ?? [] };
}

export async function buildGeneGuide(seed: Seed, audit: AuditEntry[]): Promise<GeneGuide> {
  const texts = await sourceTexts([...seed.genes.flatMap((g) => g.evidence), ...seed.notes.flatMap((n) => n.evidence)].map((q) => q.ref));
  const gwas = await gwasCounts(new Set([...seed.genes.flatMap((g) => g.sites.map((s) => s.rsid)), ...seed.unsupported.map((u) => u.rsid)]));
  // dbSNP records first (cached), so the 1000 Genomes file is streamed once for every site.
  const all = new Map<string, VariantSite>();
  for (const g of seed.genes) for (const x of g.sites) {
    const site = await fetchSite({ rsid: x.rsid, gene: g.gene, label: `${g.gene} ${x.alleleName}`, domain: "metabolism" });
    if (site) all.set(x.rsid, site);
  }
  const kg = await kgFrequencies([...all.values()]);
  const entries: GeneGuideEntry[] = [];
  for (const g of seed.genes) {
    const subject = `gene guide ${g.id}`;
    const evidence = verifyQuotes(subject, g.evidence, texts, audit);
    if (!evidence) continue;
    const orphans = orphanNumbers([g.what, g.verdictNote, g.caveat, ...(g.actions ?? []), ...g.readings.map((r) => r.text)], evidence, [g.gene, g.title, ...g.sites.map((x) => x.alleleName)]);
    if (orphans.length) { audit.push({ stage: "verify", subject, outcome: "dropped", detail: `numbers not in any verified quote: ${orphans.join(", ")}` }); continue; }
    const sites: GeneGuideSite[] = [];
    for (const s of g.sites) { const x = await guideSite(s, g.gene, subject, audit, gwas, kg); if (x) sites.push(x); }
    if (sites.length !== g.sites.length) continue;
    entries.push({ ...g, sites, evidence });
    audit.push({ stage: "verify", subject, outcome: "ok", detail: `${evidence.length} quote(s), ${sites.length} site(s) verified.` });
  }
  const unsupported = [];
  for (const u of seed.unsupported) {
    const site = await fetchSite({ rsid: u.rsid, gene: u.gene, label: u.rsid, domain: "metabolism" });
    if (!site) continue;
    const g = gwas?.get(u.rsid);
    unsupported.push({ ...u, site, gwasPubs: g?.pubs ?? null, gwasTraits: g?.traits ?? [] });
  }
  const notes = seed.notes.flatMap((n) => {
    const evidence = verifyQuotes(`gene guide note ${n.id}`, n.evidence, texts, audit);
    if (!evidence) return [];
    const orphans = orphanNumbers([n.text], evidence);
    if (orphans.length) { audit.push({ stage: "verify", subject: `gene guide note ${n.id}`, outcome: "dropped", detail: `numbers not in any verified quote: ${orphans.join(", ")}` }); return []; }
    return [{ ...n, evidence }];
  });
  return { builtAt: today(), gwasAvailable: !!gwas, entries, unsupported, notes };
}

async function main() {
  const seed = readJson<Seed>("pipeline/seeds/genes.json");
  const audit: AuditEntry[] = [];
  const guide = await buildGeneGuide(seed, audit);
  writeJson("pipeline/out/genes.json", { guide, audit });
  console.log(`gene guide: ${guide.entries.length}/${seed.genes.length} genes, ${guide.unsupported.length} unsupported sites, ${guide.notes.length}/${seed.notes.length} notes`);
  for (const a of audit.filter((x) => x.outcome === "dropped")) console.log(`  DROPPED ${a.subject}: ${a.detail}`);
}

if (process.argv[1]?.endsWith("genes.ts")) main().catch((e) => { console.error(e); process.exit(1); });

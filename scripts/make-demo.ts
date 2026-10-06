// Generates the SYNTHETIC demo files from the evidence bundle's own site
// definitions (forward-strand alleles, GRCh37 positions). No real person's data.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { EvidenceBundle, VariantSite } from "../src/core/types";

const b: EvidenceBundle = JSON.parse(readFileSync("src/evidence/bundle.json", "utf8"));

/** The allele a demo "copy" refers to: the ClinVar allele if there is one, else dbSNP's main alternate allele. */
function altFor(s: VariantSite): string {
  return b.clinvar.find((r) => r.rsid === s.rsid && r.stars > 0)?.altAllele ?? s.mainAlt;
}
function call(s: VariantSite, copies: number): string[] {
  const alt = altFor(s);
  const ref = alt === s.ref ? s.alts[0] : s.ref;
  if (s.kind === "deletion" || s.kind === "insertion") {
    const altCode = s.kind === "deletion" ? "D" : "I", refCode = s.kind === "deletion" ? "I" : "D";
    return [copies >= 1 ? altCode : refCode, copies === 2 ? altCode : refCode];
  }
  return [copies >= 1 ? alt : ref, copies === 2 ? alt : ref].sort();
}

// copies of altFor(site); "skip" = not on the chip; "nc" = no-call
type Spec = Record<string, number | "skip" | "nc">;
const spec23: Spec = {
  rs1800562: 1, rs1799945: 1, rs6025: 0, rs1799963: 0, rs113993960: 0, rs334: 0, rs76763715: 0, rs80357906: "skip", rs80359550: "nc",
  rs7903146: 1, rs1801282: 0, rs429358: 1, rs7412: 0, rs4988235: 0, rs1801133: 2, rs9939609: 1, rs671: 0, rs1229984: 0,
  rs2282679: 1, rs2472297: 1, rs762551: 1, rs1815739: 1,
};
const specAnc: Spec = {
  rs1800562: 2, rs1799945: 0, rs6025: 1, rs1799963: 0, rs113993960: "skip", rs334: 0, rs76763715: "skip", rs80357906: "skip", rs80359550: "skip",
  rs7903146: 2, rs1801282: 1, rs429358: 0, rs7412: 1, rs4988235: 2, rs1801133: 0, rs9939609: 0, rs671: 1, rs1229984: 1,
  rs2282679: 0, rs2472297: 0, rs762551: "nc", rs1815739: 2,
};
// Gene guide sites: copies of the guide's own (forward-strand) allele. Sites already in the spec above are skipped.
const gSpec23: Spec = {
  rs17822931: 0, rs1726866: 2, rs10246939: 2, rs12913832: 2, rs1805007: 1, rs1805008: 0, rs492602: 2, rs10741657: 1, rs12785878: 1,
  rs174546: 1, rs6564851: 1, rs33972313: 0, rs2187668: 1, rs7454108: 0, rs10455872: 1, rs3798220: 0, rs1050828: 0,
  rs5751876: 1, rs1801260: 0, rs7946: 2, rs1801394: 1, rs1801131: 1, rs7501331: 0, rs4680: 1, rs1544410: 1, rs731236: 1,
  rs4880: 2, rs1695: 0, rs8192678: 1, rs1042713: 1, rs4343: 1, rs699: 2, rs5082: 0, rs5400: 0, rs1800795: 1,
  rs738409: 1, rs58542926: 0, rs2231142: 1, rs662799: 0,
};
const gSpecAnc: Spec = {
  rs17822931: 2, rs1726866: 1, rs10246939: 1, rs12913832: 0, rs1805007: "skip", rs1805008: 0, rs492602: 1, rs10741657: 2, rs12785878: 0,
  rs174546: 2, rs6564851: 2, rs33972313: 1, rs2187668: 0, rs7454108: 0, rs10455872: "skip", rs3798220: "skip", rs1050828: 1,
  rs5751876: "skip", rs1801260: 1, rs7946: 1, rs1801394: 2, rs1801131: 0, rs7501331: 1, rs4680: 2, rs1544410: 0, rs731236: 0,
  rs4880: 1, rs1695: 1, rs8192678: 0, rs1042713: 2, rs4343: 0, rs699: 1, rs5082: 1, rs5400: 1, rs1800795: "skip",
  rs738409: 2, rs58542926: 1, rs2231142: 0, rs662799: 1,
};
function geneRows(spec: Spec, base: Spec) {
  const guide = b.geneGuide;
  if (!guide) return [];
  const sites = new Map<string, { site: VariantSite; allele: string }>();
  for (const e of guide.entries) for (const s of e.sites) sites.set(s.rsid, { site: s.site, allele: s.allele });
  for (const u of guide.unsupported) if (!sites.has(u.rsid)) sites.set(u.rsid, { site: u.site, allele: u.site.mainAlt });
  return [...sites].filter(([rsid]) => base[rsid] === undefined && spec[rsid] !== undefined && spec[rsid] !== "skip").map(([rsid, { site, allele }]) => {
    const v = spec[rsid];
    const other = allele === site.ref ? site.mainAlt : site.ref;
    const n = v as number;
    return { rsid, chrom: site.chrom, pos: site.pos37 ?? 0, alleles: v === "nc" ? null : [n >= 1 ? allele : other, n === 2 ? allele : other].sort() };
  });
}

const FILLER = 3000;
const BASES = ["A", "C", "G", "T"];
/** mulberry32: small deterministic PRNG with full 32-bit period (integer-safe, unlike a naive LCG in doubles). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(42);
const chromNum = (c: string) => ({ X: "23", Y: "24", MT: "26" } as Record<string, string>)[c] ?? c;

function rows(spec: Spec) {
  return b.sites.filter((s) => spec[s.rsid] !== "skip" && spec[s.rsid] !== undefined).map((s) => {
    const v = spec[s.rsid];
    return { rsid: s.rsid, chrom: s.chrom, pos: s.pos37 ?? 0, alleles: v === "nc" ? null : call(s, v as number) };
  });
}
function filler(i: number) {
  const a = BASES[Math.floor(rng() * 4)], c = BASES[Math.floor(rng() * 4)];
  return { rsid: `rs${2_100_000_000 + i}`, chrom: String(1 + (i % 22)), pos: 1_000_000 + i * 97, alleles: rng() < 0.01 ? null : [a, c].sort() };
}

// Synthetic genotypes at real bulk-tier sites, so the demo exercises the genome-wide screens.
// ClinVar sites are homozygous reference except two deliberately "carried" synthetic hits.
function bulkRows(seed: number, carriedClinVar: number) {
  const out: { rsid: string; chrom: string; pos: number; alleles: string[] | null }[] = [];
  const cvPath = "public/data/clinvar.json.gz", gwPath = "public/data/gwas.json.gz";
  if (!existsSync(cvPath) || !existsSync(gwPath)) return out;
  const cv = JSON.parse(gunzipSync(readFileSync(cvPath)).toString());
  const gw = JSON.parse(gunzipSync(readFileSync(gwPath)).toString());
  const r = mulberry32(seed);
  const snv = (cv.rows as any[]).filter((row) => row[3].length === 1 && row[4].length === 1 && row[6] >= 2);
  for (let i = 0; i < 4000; i++) {
    const row = snv[Math.floor(r() * snv.length)];
    const carried = i < carriedClinVar;
    out.push({ rsid: `rs${row[0]}`, chrom: row[1], pos: row[2], alleles: carried ? [row[3], row[4]].sort() : [row[3], row[3]] });
  }
  const sites = Object.entries(gw.sites as Record<string, any[]>);
  for (let i = 0; i < 16000; i++) {
    const [rsid, s] = sites[Math.floor(r() * sites.length)];
    const a = () => (r() < 0.35 ? s[3] : s[2]);
    out.push({ rsid, chrom: s[0], pos: s[1] ?? 0, alleles: r() < 0.01 ? null : [a(), a()].sort() });
  }
  const seen = new Set<string>();
  const curated = new Set([...b.sites.flatMap((x) => [x.rsid, ...x.aliases]),
    ...(b.geneGuide?.entries.flatMap((e) => e.sites.map((s) => s.rsid)) ?? []), ...(b.geneGuide?.unsupported.map((u) => u.rsid) ?? [])]);
  return out.filter((o) => !curated.has(o.rsid) && (o.alleles ?? []).every((a) => /^[ACGT]$/.test(a)) && !seen.has(o.rsid) && seen.add(o.rsid));
}

// 23andMe files list some clinical variants under internal "i" IDs; relabel 50 demo sites that way
// so position-based linking is exercised.
const bulk23 = bulkRows(7, 2).map((r, i) => (i >= 10 && i < 60 ? { ...r, rsid: `i${5000000 + i}` } : r));
const all23 = [...rows(spec23), ...geneRows(gSpec23, spec23), ...bulk23, ...Array.from({ length: FILLER }, (_, i) => filler(i))];
mkdirSync("public/demo", { recursive: true });
writeFileSync("public/demo/synthetic-23andme.txt", [
  "# SYNTHETIC DEMO FILE: generated by scripts/make-demo.ts. Not a real person's genotype.",
  "# This data file generated by 23andMe at: Thu Jan 01 00:00:00 2026",
  "# More information on reference human assembly build 37 (a.k.a. Annotation Release 104):",
  "# rsid\tchromosome\tposition\tgenotype",
  ...all23.map((r) => `${r.rsid}\t${r.chrom}\t${r.pos}\t${r.alleles ? r.alleles.join("") : "--"}`),
].join("\n") + "\n");

const allAnc = [...rows(specAnc), ...geneRows(gSpecAnc, specAnc), ...bulkRows(99, 1), ...Array.from({ length: FILLER }, (_, i) => filler(i + FILLER))];
writeFileSync("public/demo/synthetic-ancestrydna.txt", [
  "#AncestryDNA raw data download",
  "#SYNTHETIC DEMO FILE: generated by scripts/make-demo.ts. Not a real person's genotype.",
  "#Genetic data is provided below as five TAB delimited columns. Columns two and three contain the chromosome and basepair position of the SNP using human reference build 37.1 coordinates.",
  "rsid\tchromosome\tposition\tallele1\tallele2",
  ...allAnc.map((r) => `${r.rsid}\t${chromNum(r.chrom)}\t${r.pos}\t${r.alleles ? r.alleles.join("\t") : "0\t0"}`),
].join("\r\n") + "\r\n");
console.log(`demo files: ${all23.length} and ${allAnc.length} rows`);

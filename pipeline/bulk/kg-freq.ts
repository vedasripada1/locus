// Exact allele frequencies for ClinVar variants from the 1000 Genomes phase 3 sites VCF
// (2,504 people, 26 populations). Matched by chromosome, GRCh37 position, REF and ALT, so
// multi-allelic sites (e.g. Factor V Leiden, T/C/A) get the right allele's frequency, and a
// variant absent from the file is reliably "not observed in 1000 Genomes".
// Output: pipeline/out/clinvar-freq.json  { freq: { rsid: { ALLELE: [globalAF, maxContinentalAF, continent, REF] } } }
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT, readJson, writeJson } from "../lib/http";

const POPS = ["EAS", "AMR", "AFR", "EUR", "SAS"] as const;
const round = (x: number) => Math.round(Math.max(0, x) * 1e6) / 1e6;

async function main() {
  const cv = readJson<{ rows: [number, string, number, string, string][] }>("pipeline/out/clinvar-bulk.json");
  const bundle = readJson<{ clinvar: { rsid: string; altAllele: string }[]; sites: { rsid: string; chrom: string; pos37: number | null; ref: string; kind: string }[] }>("src/evidence/bundle.json");
  // wanted: "chrom:pos" → [{rsid, ref, alt}]
  const wanted = new Map<string, { rsid: string; ref: string; alt: string }[]>();
  const add = (chrom: string, pos: number | null, rsid: string, ref: string, alt: string) => {
    if (pos == null) return;
    const k = `${chrom}:${pos}`;
    (wanted.get(k) ?? wanted.set(k, []).get(k)!).push({ rsid, ref, alt });
  };
  for (const r of cv.rows) add(r[1], r[2], `rs${r[0]}`, r[3], r[4]);
  for (const c of bundle.clinvar) {
    const s = bundle.sites.find((x) => x.rsid === c.rsid);
    // SNVs, and indels written out in VCF style (e.g. TCTT>T); "-" alleles have no VCF anchor base.
    if (s && /^[ACGT]+$/.test(s.ref) && /^[ACGT]+$/.test(c.altAllele)) add(s.chrom, s.pos37, s.rsid, s.ref, c.altAllele);
  }
  const freq: Record<string, Record<string, [number, number, string, string?]>> = {};
  for (const list of wanted.values()) for (const w of list) (freq[w.rsid] ??= {})[w.alt] = [0, 0, "", w.ref]; // default: not observed
  let lines = 0, hits = 0;
  const rl = createInterface({ input: createReadStream(join(ROOT, "pipeline/cache/bulk/1kg_sites.vcf.gz")).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.charCodeAt(0) === 35) continue; // '#'
    lines++;
    const t1 = line.indexOf("\t"), t2 = line.indexOf("\t", t1 + 1);
    const key = `${line.slice(0, t1)}:${line.slice(t1 + 1, t2)}`;
    const want = wanted.get(key);
    if (!want) continue;
    const c = line.split("\t", 8);
    const ref = c[3], alts = c[4].split(","), info = c[7];
    const vals = (tag: string) => (info.match(new RegExp(`(?:^|;)${tag}=([^;]+)`))?.[1] ?? "").split(",").map(Number);
    // Frequency of every allele at the site, REF included (REF = 1 − sum of ALT frequencies).
    // Needed because the GRCh37 reference sometimes carries the rarer allele (e.g. Factor V Leiden: REF T 0.6%, ALT C 99.4%).
    const af = vals("AF"), pops = POPS.map((p) => vals(`${p}_AF`));
    const freqOf = (i: number) => (i < 0 ? 1 - af.reduce((a, b) => a + (b || 0), 0) : af[i] ?? 0);
    const popOf = (j: number, i: number) => (i < 0 ? 1 - pops[j].reduce((a, b) => a + (b || 0), 0) : pops[j][i] ?? 0);
    for (const w of want) {
      // Same variant if our two alleles are the site's REF and one ALT, in either order.
      const idx = (x: string) => (x === ref ? -1 : alts.indexOf(x));
      const iAlt = idx(w.alt), iRef = idx(w.ref);
      // Either order only for SNVs (where the GRCh37 reference can carry the rarer allele); indels must match exactly,
      // because the same letters at one position can describe different insertion/deletion events.
      const snv = w.ref.length === 1 && w.alt.length === 1;
      const sameVariant = snv ? (w.alt === ref || iAlt >= 0) && (w.ref === ref || iRef >= 0) : w.ref === ref && iAlt >= 0;
      if (!sameVariant || w.alt === w.ref) continue;
      let max = 0, where = "";
      POPS.forEach((p, j) => { const v = popOf(j, iAlt); if (v > max) { max = v; where = p; } });
      freq[w.rsid][w.alt] = [round(freqOf(iAlt)), round(max), where, ref];
      hits++;
    }
  }
  writeJson("pipeline/out/clinvar-freq.json", { source: "1000 Genomes phase 3 sites VCF v5b (2,504 people; EAS, AMR, AFR, EUR, SAS)", retrievedAt: new Date().toISOString().slice(0, 10), freq });
  console.log(`1000G lines ${lines.toLocaleString()}; ClinVar alleles observed in 1000G: ${hits.toLocaleString()} of ${Object.values(freq).reduce((n, v) => n + Object.keys(v).length, 0).toLocaleString()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

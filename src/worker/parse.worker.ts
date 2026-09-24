// Runs off the main thread: reads the file, loads the bulk evidence (same-origin only),
// parses, and screens every bulk site present in the file. Returns the parsed genome
// plus bulk hits. Nothing here can reach another origin (CSP connect-src 'self').
import { unzipSync, strFromU8 } from "fflate";
import { parseGenotypeText, ParseError } from "../core/parse";
import { bulkRsids, loadGz, positionCandidates, screenClinVar, screenGwas, type BulkClinVarFile, type BulkGwasFile, type BulkResult } from "../core/bulk";
import { auditSummary, linkByPosition, newAudit, recordAudit } from "../core/audit";
import { matchSite } from "../core/match";
import type { ClinGenValidity, VariantSite } from "../core/types";

export type WorkerIn = { file?: File; text?: string; keep: string[]; exclude: string[]; clingen: ClinGenValidity[]; sites: VariantSite[]; dataBase: string };

async function readText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) return new TextDecoder().decode(buf);
  const entries = Object.entries(unzipSync(buf)).filter(([n]) => /\.(txt|csv|tsv)$/i.test(n) && !n.startsWith("__MACOSX"));
  if (!entries.length) throw new ParseError("The .zip contains no .txt raw data file.", "zip-empty");
  entries.sort((a, b) => b[1].length - a[1].length);
  return strFromU8(entries[0][1]);
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const { dataBase } = e.data;
  try {
    post({ progress: "Loading evidence data…" });
    const [text, cv, gw] = await Promise.all([
      e.data.text ?? readText(e.data.file!),
      loadGz<BulkClinVarFile>(`${dataBase}clinvar.json.gz`).catch(() => null),
      loadGz<BulkGwasFile>(`${dataBase}gwas.json.gz`).catch(() => null),
    ]);
    post({ progress: "Reading your whole file…" });
    const keep = new Set([...e.data.keep, ...bulkRsids(cv, gw)]);
    const genome = parseGenotypeText(text, keep, { fullTable: true });

    post({ progress: "Linking every row to the evidence (by rsID, then by position)…" });
    const curated = e.data.sites.filter((x) => x.kind === "snv").map((x) => ({ rsid: x.rsid, chrom: x.chrom, pos: x.pos37, alleles: [x.ref, ...x.alts] }));
    const linkedByPosition = linkByPosition(genome, [...curated, ...positionCandidates(cv, gw)]);

    post({ progress: "Matching against ClinVar and the GWAS Catalog…" });
    const audit = newAudit(genome.table?.id.length ?? genome.stats.totalRows);
    for (const site of e.data.sites) recordAudit(audit, matchSite(genome, site));
    const exclude = new Set(e.data.exclude);
    const bulk: BulkResult | null = cv && gw ? { clinvar: screenClinVar(genome, cv, e.data.clingen, audit), gwas: screenGwas(genome, gw, exclude, audit) } : null;
    post({ ok: true, genome, bulk, audit: { ...auditSummary(audit), linkedByPosition }, bulkError: bulk ? null : "Bulk evidence files (public/data) could not be loaded; showing the curated report only." });
  } catch (err) {
    const known = err instanceof ParseError;
    post({ ok: false, error: known ? err.message : `Unexpected error while reading the file: ${(err as Error).message}`, code: known ? err.code : "internal" });
  }
};

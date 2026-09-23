import type { FileFormat, GenomeBuild, GenotypeCall, ParseIssue, ParsedGenome, ParseStats } from "./types";

/** Thrown for files we cannot interpret at all. Message is user-facing. */
export class ParseError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

const ANCESTRY_CHROM: Record<string, string> = { "23": "X", "24": "Y", "25": "X", "26": "MT" };
const VALID_ALLELE = /^[ACGTID]$/;
const MAX_MALFORMED_FRACTION = 0.02;
const LOW_CALL_RATE = 0.95;

export function detectFormat(headerLines: string[], firstDataLine: string | undefined): FileFormat {
  const header = headerLines.join("\n");
  if (/^##fileformat=VCF/m.test(header)) {
    throw new ParseError("This looks like a VCF file. The MVP reads AncestryDNA and 23andMe raw data only.", "vcf-unsupported");
  }
  if (/23andMe/i.test(header)) return "23andme";
  if (/AncestryDNA/i.test(header)) return "ancestrydna";
  // Fall back to column shape.
  const cols = firstDataLine?.split("\t") ?? [];
  if (/^rsid\s+chromosome\s+position\s+allele1\s+allele2/i.test(firstDataLine ?? "")) return "ancestrydna";
  if (/^rsid,/i.test(firstDataLine ?? "") || (firstDataLine ?? "").includes(",")) {
    throw new ParseError(
      "This looks like a comma-separated file (e.g. MyHeritage or FamilyTreeDNA). Only AncestryDNA and 23andMe tab-separated files are supported.",
      "csv-unsupported",
    );
  }
  if (cols.length === 4 && /^(rs|i)\d+$/.test(cols[0])) return "23andme";
  if (cols.length === 5 && /^(rs|i)\d+$/.test(cols[0])) return "ancestrydna";
  throw new ParseError(
    "Could not recognise this file. Upload the unmodified raw data download from AncestryDNA or 23andMe (.txt or the .zip it came in).",
    "unknown-format",
  );
}

export function detectBuild(headerLines: string[]): { build: GenomeBuild; evidence: string } {
  const header = headerLines.join("\n");
  const grch = header.match(/GRCh(3[78])/i);
  const build = header.match(/build\s*(3[678])(?:\.\d+)?/i);
  const n = grch?.[1] ?? build?.[1];
  const line = headerLines.find((l) => /GRCh3[78]|build\s*3[678]/i.test(l))?.replace(/^#\s*/, "").trim();
  if (n === "37") return { build: "GRCh37", evidence: line ?? "header" };
  if (n === "38") return { build: "GRCh38", evidence: line ?? "header" };
  if (n === "36") return { build: "unknown", evidence: `File reports NCBI build 36 (${line}); positions cannot be checked.` };
  return { build: "unknown", evidence: "No genome build stated in the file header." };
}

function normaliseAlleles(tokens: string[]): { alleles: string[]; ok: boolean } {
  const joined = tokens.join("").toUpperCase();
  if (joined === "" || joined === "--" || /^0+$/.test(joined) || joined === "-") return { alleles: [], ok: true };
  const alleles = joined.split("");
  if (alleles.length > 2 || !alleles.every((a) => VALID_ALLELE.test(a))) return { alleles: [], ok: false };
  return { alleles, ok: true };
}

/**
 * Parse a raw genotype file. Only rsIDs in `keep` are retained in memory;
 * every row still counts toward validation statistics.
 */
export function parseGenotypeText(text: string, keep: Set<string>): ParsedGenome {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  let i = 0;
  for (; i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === ""); i++) header.push(lines[i]);
  if (i >= lines.length) throw new ParseError("The file contains no genotype rows.", "empty");

  const format = detectFormat(header, lines[i]);
  const { build, evidence } = detectBuild(header);
  if (/^rsid\s/i.test(lines[i])) i++; // AncestryDNA column header row

  const issues: ParseIssue[] = [];
  const calls = new Map<string, GenotypeCall>();
  const seen = new Set<string>();
  const stats: ParseStats = {
    totalRows: 0, calledRows: 0, noCallRows: 0, malformedRows: 0, duplicateRsids: 0, callRate: 0, chromosomes: {},
  };
  const expectedCols = format === "23andme" ? 4 : 5;
  let firstMalformed: number | undefined;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line.startsWith("#")) continue;
    stats.totalRows++;
    const cols = line.split("\t");
    const pos = Number(cols[2]);
    if (cols.length !== expectedCols || !cols[0] || !Number.isFinite(pos)) {
      stats.malformedRows++;
      firstMalformed ??= i + 1;
      continue;
    }
    const rsid = cols[0].trim().toLowerCase();
    let chrom = cols[1].trim().toUpperCase().replace(/^CHR/, "");
    if (format === "ancestrydna") chrom = ANCESTRY_CHROM[chrom] ?? chrom;
    const tokens = format === "23andme" ? [cols[3].trim()] : [cols[3].trim(), cols[4].trim()];
    const { alleles, ok } = normaliseAlleles(tokens);
    if (!ok) {
      stats.malformedRows++;
      firstMalformed ??= i + 1;
      continue;
    }
    stats.chromosomes[chrom] = (stats.chromosomes[chrom] ?? 0) + 1;
    if (alleles.length) stats.calledRows++;
    else stats.noCallRows++;

    if (seen.has(rsid)) {
      stats.duplicateRsids++;
      const prev = calls.get(rsid);
      if (prev && [...prev.alleles].sort().join("") !== [...alleles].sort().join("")) {
        // Two different answers for one site: trust neither.
        calls.set(rsid, { ...prev, alleles: [], raw: `${prev.raw} / ${tokens.join("")} (discordant duplicate rows)` });
      }
      continue;
    }
    seen.add(rsid);
    if (keep.has(rsid)) calls.set(rsid, { rsid, chrom, pos, alleles, raw: tokens.join(format === "23andme" ? "" : " ") });
  }

  const genotyped = stats.calledRows + stats.noCallRows;
  stats.callRate = genotyped ? stats.calledRows / genotyped : 0;

  if (genotyped === 0) throw new ParseError("No readable genotype rows were found in the file.", "no-rows");
  if (stats.malformedRows / stats.totalRows > MAX_MALFORMED_FRACTION) {
    throw new ParseError(
      `${stats.malformedRows} of ${stats.totalRows} rows could not be read (first at line ${firstMalformed}). The file may be truncated, edited, or not a raw data file.`,
      "too-many-malformed",
    );
  }
  if (stats.malformedRows) {
    issues.push({ severity: "warning", code: "malformed-rows", line: firstMalformed,
      message: `${stats.malformedRows} unreadable row(s) were skipped (first at line ${firstMalformed}).` });
  }
  if (stats.duplicateRsids) {
    issues.push({ severity: "warning", code: "duplicates",
      message: `${stats.duplicateRsids} duplicate rsID row(s). Where duplicates disagree, the site is treated as a no-call.` });
  }
  if (stats.callRate < LOW_CALL_RATE) {
    issues.push({ severity: "warning", code: "low-call-rate",
      message: `Call rate is ${(stats.callRate * 100).toFixed(1)}% (typical files are above 98%). Sample or chip quality may be low; treat all results with extra caution.` });
  }
  if (build !== "GRCh37") {
    issues.push({ severity: "warning", code: "build",
      message: `${evidence} Variants are matched by rsID; positions are only cross-checked for GRCh37/GRCh38.` });
  }
  if (stats.totalRows < 100_000) {
    issues.push({ severity: "info", code: "small-file",
      message: `Only ${stats.totalRows.toLocaleString()} rows. Full downloads usually have 600,000+; this may be a partial or test file.` });
  }
  return { format, build, buildEvidence: evidence, calls, stats, issues };
}

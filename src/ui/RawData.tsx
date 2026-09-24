import { useMemo, useState } from "react";
import type { Report } from "../core/types";

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(n === d ? 0 : 2)}%` : "—");

/** Plain summary line for the results page. */
export function accuracyLine(r: Report): string | null {
  const a = r.audit;
  if (!a) return null;
  const readable = a.sites - a.noCall;
  const posOk = a.posChecked ? `positions matched the reference for ${pct(a.posChecked - a.posMismatch, a.posChecked)}` : "positions could not be checked (build not GRCh37)";
  return `Accuracy check: all ${a.rowsInFile.toLocaleString()} rows of your file were read and ${a.sites.toLocaleString()} were linked to evidence; ${posOk}, and alleles were consistent with the reference for ${pct(readable - a.alleleMismatch, readable)} of readable sites.`;
}

export function AccuracyPanel({ r }: { r: Report }) {
  const a = r.audit;
  if (!a) return null;
  const readable = a.sites - a.noCall;
  const rows: [string, string, string][] = [
    ["Rows in your file", a.rowsInFile.toLocaleString(), "Every row was read into a table (see Your raw data below)."],
    ["Rows linked to evidence", a.sites.toLocaleString(), "Curated sites, ClinVar pathogenic variants and GWAS Catalog sites present in your file."],
    ["…linked by rsID", a.byRsid.toLocaleString(), "The file's ID matched the evidence rsID (or a merged older rsID)."],
    ["…linked by position", a.byPosition.toLocaleString(), "The ID differed (for example 23andMe's internal \"i\" IDs), but chromosome, GRCh37 position and alleles matched. SNVs only."],
    ["Position agrees with GRCh37", `${pct(a.posChecked - a.posMismatch, a.posChecked)} (${(a.posChecked - a.posMismatch).toLocaleString()} of ${a.posChecked.toLocaleString()})`, "A mismatch usually means a different genome build or an rsID that was reassigned; those sites are flagged."],
    ["Alleles on the forward strand", a.forward.toLocaleString(), "Your alleles are exactly the reference's alleles."],
    ["Alleles on the opposite strand", a.complemented.toLocaleString(), "Your file reported the other DNA strand; alleles were flipped (A↔T, C↔G) before interpreting."],
    ["Strand-ambiguous (A/T or C/G)", a.palindromic.toLocaleString(), "Both strands look the same, so effect-allele copies are not counted at these sites."],
    ["Insertion/deletion (I/D codes)", a.indel.toLocaleString(), "Your file writes these as I (insertion) and D (deletion); they are translated to the actual DNA change."],
    ["Allele mismatch (not interpreted)", `${a.alleleMismatch.toLocaleString()} (${pct(a.alleleMismatch, readable)})`, "Alleles fit neither strand of the reference; these sites are skipped, never guessed."],
    ["No-call", a.noCall.toLocaleString(), "The chip could not read the site. Unknown, not negative."],
  ];
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3>Accuracy check</h3>
      <p style={{ marginTop: 0 }}>{accuracyLine(r)}</p>
      <div className="table-scroll">
        <table>
          <tbody>{rows.map(([k, v, note]) => <tr key={k}><th style={{ position: "static", width: 260 }}>{k}</th><td className="mono" style={{ whiteSpace: "nowrap" }}>{v}</td><td className="muted">{note}</td></tr>)}</tbody>
        </table>
      </div>
      {a.examples.length > 0 && (
        <details>
          <summary>Sites flagged by the check ({a.examples.length}{a.examples.length === 40 ? "+" : ""})</summary>
          <ul className="limits">{a.examples.map((e, i) => <li key={i}><b>{e.site}</b> (file ID {e.fileId}): {e.kind === "position" ? "position differs" : "alleles don't match"}, {e.detail}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

const PAGE = 100;
const plain = (g: string) => {
  if (!g) return "no-call";
  if (/[ID]/.test(g)) return `${g} (I = insertion, D = deletion)`;
  return g.length === 1 ? `${g} (single copy)` : g[0] === g[1] ? `two copies of ${g[0]}` : `one ${g[0]}, one ${g[1]}`;
};

/** Every row of the file, searchable, with a flag for rows that carry evidence. */
export function RawDataTable({ r }: { r: Report }) {
  const t = r.table;
  const [q, setQ] = useState("");
  const [onlyEvidence, setOnlyEvidence] = useState(true);
  const [page, setPage] = useState(0);
  const evidence = useMemo(() => new Set(r.audit?.fileIds ?? []), [r.audit]);
  const idx = useMemo(() => {
    if (!t) return [];
    const needle = q.trim().toLowerCase();
    const m = needle.match(/^(?:chr)?(\w+):(\d+)$/);
    const out: number[] = [];
    for (let i = 0; i < t.id.length; i++) {
      if (onlyEvidence && !evidence.has(t.id[i])) continue;
      if (needle) {
        if (m ? !(t.chrom[i].toLowerCase() === m[1] && String(t.pos[i]) === m[2]) : !t.id[i].includes(needle) && t.chrom[i].toLowerCase() !== needle) continue;
      }
      out.push(i);
    }
    return out;
  }, [t, q, onlyEvidence, evidence]);
  if (!t) return <p className="muted">The raw-data table is not available for this report.</p>;
  const pages = Math.max(1, Math.ceil(idx.length / PAGE));
  const view = idx.slice(page * PAGE, page * PAGE + PAGE);
  return (
    <>
      <div className="btn-row no-print" style={{ marginBottom: 10, gap: "8px 16px" }}>
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="rsID, i-ID, chromosome (e.g. 7) or chr:pos (e.g. 6:26093141)" style={{ width: 380 }} aria-label="Search raw data" />
        <label><input type="checkbox" checked={onlyEvidence} onChange={(e) => { setOnlyEvidence(e.target.checked); setPage(0); }} /> Only rows with evidence ({evidence.size.toLocaleString()})</label>
        <span className="muted">{idx.length.toLocaleString()} of {t.id.length.toLocaleString()} rows</span>
      </div>
      <div className="table-scroll" style={{ maxHeight: 520 }}>
        <table>
          <thead><tr><th>ID in your file</th><th>Chromosome</th><th>Position (GRCh37)</th><th>Genotype</th><th>In plain words</th><th>Evidence</th></tr></thead>
          <tbody>
            {view.map((i) => (
              <tr key={i}>
                <td className="mono">{t.id[i]}</td><td>{t.chrom[i]}</td><td className="mono">{t.pos[i].toLocaleString()}</td>
                <td className="mono">{t.geno[i] || "--"}</td><td>{plain(t.geno[i])}</td><td>{evidence.has(t.id[i]) ? "yes" : ""}</td>
              </tr>
            ))}
            {!view.length && <tr><td colSpan={6}>No rows match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="btn-row no-print" style={{ marginTop: 10 }}>
        <button className="btn secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page + 1} of {pages}</span>
        <button className="btn secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </>
  );
}

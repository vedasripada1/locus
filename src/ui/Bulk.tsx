import { useMemo, useState } from "react";
import type { BulkGwasHit, BulkResult } from "../core/bulk";
import type { VerifiedWarning } from "../core/types";
import { FindingCard } from "./Cards";
import { LABELS, PapersList } from "./Papers";

// ─── Genome-wide ClinVar screen ────────────────────────────────────────────

export function ClinVarScreen({ bulk, warning, showSensitive }: { bulk: BulkResult["clinvar"]; warning?: VerifiedWarning; showSensitive: boolean }) {
  const [minStars, setMinStars] = useState(1);
  const shown = bulk.carried.filter((f) => f.record.stars >= minStars && (showSensitive || !f.match.site.sensitive));
  return (
    <div style={{ marginTop: 28 }}>
      <h3>Genome-wide ClinVar screen</h3>
      <p>
        Your file was checked against <b>every germline ClinVar variant classified Pathogenic or Likely pathogenic</b> (≥1★, with an rsID; ClinVar {bulk.version}).
        {" "}<b>{bulk.tested.toLocaleString()}</b> of them were on your chip and readable ({bulk.noCall.toLocaleString()} no-calls).
        The listed allele was <b>not observed at {bulk.notCarried.toLocaleString()}</b> and <b>observed at {bulk.carried.length}</b>.
        Variants not on your chip were not tested. This is the raw list before the safety checks (population frequency, review strength, inheritance, strand); the Your results tab shows which passed.
      </p>
      {warning && (
        <div className="notice alert" style={{ marginBottom: 14 }}>
          <b>{warning.title}.</b> {warning.summary}
          {warning.quotes.map((q) => <blockquote key={q.quote} className="q">"{q.quote}"</blockquote>)}
          <div className="muted" style={{ fontSize: ".85rem" }}>Source: {warning.quotes[0].citation} · <a href={warning.quotes[0].source.url} target="_blank" rel="noreferrer">{warning.quotes[0].source.version}</a></div>
        </div>
      )}
      <div className="btn-row no-print" style={{ marginBottom: 10 }}>
        <label>Minimum ClinVar review
          <select value={minStars} onChange={(e) => setMinStars(Number(e.target.value))} style={{ width: "auto", marginLeft: 6 }}>
            <option value={1}>1★ or more</option><option value={2}>2★ or more</option><option value={3}>3★ (expert panel) or more</option>
          </select>
        </label>
        <span className="muted">{shown.length} shown</span>
      </div>
      <div className="notice" style={{ marginBottom: 12 }}>
        <b>These are raw chip calls, not findings.</b> Each is checked on the Your results tab: population frequency, whether two copies are believable, review strength, inheritance and strand. Most very rare calls are set aside there as chip errors.
      </div>
      {shown.map((f) => <FindingCard key={f.record.id} f={f} raw />)}
      {!shown.length && <div className="card key-none"><p className="headline" style={{ margin: 0 }}>No pathogenic allele observed at this review level among the tested sites.</p></div>}
    </div>
  );
}

// ─── GWAS explorer ─────────────────────────────────────────────────────────

const RANK = { strong: 4, moderate: 3, limited: 2, conflicting: 1, insufficient: 0 } as const;
const PAGE = 50;

export function toCsv(hits: BulkGwasHit[]): string {
  const cols = ["rsid", "gene", "trait", "domain", "genotype", "effectAllele", "effectForward", "copies", "kind", "value", "direction", "ci", "p", "strength", "concordantPubs", "discordant", "nAssocs", "leadPmid", "pmids", "sample"] as const;
  const esc = (v: unknown) => { const s = Array.isArray(v) ? v.join(";") : String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...hits.map((h) => cols.map((c) => esc(h[c])).join(","))].join("\n");
}

export function GwasExplorer({ bulk, onCsv, initialQuery }: { bulk: BulkResult["gwas"]; onCsv: (csv: string) => void; initialQuery?: string }) {
  // A query from Search opens the explorer unfiltered, so the searched rows are visible.
  const [domain, setDomain] = useState(initialQuery ? "all" : "disease");
  const [carried, setCarried] = useState(!initialQuery);
  const [minStrength, setMinStrength] = useState<keyof typeof RANK>(initialQuery ? "insufficient" : "moderate");
  const [q, setQ] = useState(initialQuery ?? "");
  const [sort, setSort] = useState<"strength" | "p" | "trait">("strength");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const h of bulk.hits) c[h.domain] = (c[h.domain] ?? 0) + 1;
    return c;
  }, [bulk.hits]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pexp = (p: string) => { const m = p.match(/E-?(\d+)/i); return m ? Number(m[1]) : 0; };
    return bulk.hits
      .filter((h) => (domain === "all" || h.domain === domain) && (!carried || (h.copies ?? 0) > 0) && RANK[h.strength] >= RANK[minStrength])
      .filter((h) => !needle || h.rsid.toLowerCase() === needle || h.gene.toLowerCase().includes(needle) || h.trait.toLowerCase().includes(needle))
      .sort((a, b) => sort === "trait" ? a.trait.localeCompare(b.trait) : sort === "p" ? pexp(b.p) - pexp(a.p) : RANK[b.strength] - RANK[a.strength] || b.concordantPubs - a.concordantPubs || pexp(b.p) - pexp(a.p));
  }, [bulk.hits, domain, carried, minStrength, q, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const view = rows.slice(page * PAGE, page * PAGE + PAGE);
  const reset = () => setPage(0);

  return (
    <>
      <p>
        <b>{bulk.hits.length.toLocaleString()}</b> genome-wide significant (p &lt; 5×10⁻⁸) GWAS Catalog associations involve <b>{bulk.tested.toLocaleString()}</b> sites
        that are readable in your file (catalog download {bulk.version}). Each row is one variant–trait pair, grouped across every study that reported it. These are small, population-level associations, not diagnoses.
        The default view shows traits in the disease category where you carry the reported allele and at least two publications agree on direction.
      </p>
      <div className="btn-row no-print" style={{ marginBottom: 10, gap: "8px 16px" }}>
        <label>Category <select value={domain} onChange={(e) => { setDomain(e.target.value); reset(); }} style={{ width: "auto" }}>
          <option value="disease">Disease ({(counts.disease ?? 0).toLocaleString()})</option>
          <option value="metabolism">Measurements / metabolism ({(counts.metabolism ?? 0).toLocaleString()})</option>
          <option value="performance">Performance ({(counts.performance ?? 0).toLocaleString()})</option>
          <option value="other">Other traits ({(counts.other ?? 0).toLocaleString()})</option>
          <option value="all">All ({bulk.hits.length.toLocaleString()})</option>
        </select></label>
        <label>Evidence <select value={minStrength} onChange={(e) => { setMinStrength(e.target.value as keyof typeof RANK); reset(); }} style={{ width: "auto" }}>
          <option value="strong">Strong (≥3 papers agree)</option><option value="moderate">Moderate or better</option><option value="limited">Limited or better</option><option value="insufficient">Any, including conflicting</option>
        </select></label>
        <label><input type="checkbox" checked={carried} onChange={(e) => { setCarried(e.target.checked); reset(); }} /> Only alleles I carry</label>
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ width: "auto" }}>
          <option value="strength">Evidence</option><option value="p">p-value</option><option value="trait">Trait A–Z</option>
        </select></label>
        <input type="search" placeholder="Trait, gene or rsID" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} style={{ width: 200 }} />
        <button className="btn secondary small" onClick={() => onCsv(toCsv(rows))}>CSV ({rows.length.toLocaleString()})</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Trait</th><th>Variant</th><th>Your genotype</th><th>Effect allele · copies</th><th>Effect</th><th>p</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {view.map((h) => {
              const key = `${h.rsid}|${h.traitUri}`;
              return [
                <tr key={key}>
                  <td>{h.trait}<div className="muted" style={{ fontSize: ".8rem" }}>{h.categories}</div></td>
                  <td className="mono">{h.gene || "—"}<div className="muted">{h.rsid}</div></td>
                  <td className="mono">{h.genotype}{h.orientation === "complemented" && ` → ${h.forwardGenotype}`}{h.orientation === "ambiguous-palindromic" && <div><span className="chip warn">strand-ambiguous</span></div>}</td>
                  <td className="mono">{h.effectAllele}{h.effectForward && h.effectForward !== h.effectAllele ? ` (fwd ${h.effectForward})` : ""} · {h.copies ?? "n/c"}</td>
                  <td>{h.kind === "OR" ? `OR ${h.value}` : `β ${h.value}`} {h.direction !== "unclear" && h.kind === "beta" ? (h.direction === "increase" ? "↑" : "↓") : ""}<div className="muted" style={{ fontSize: ".8rem" }}>{h.ci}</div></td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{h.p}</td>
                  <td><span className={`chip ${h.strength}`}>{h.strength}</span><div className="muted" style={{ fontSize: ".8rem" }}>{h.concordantPubs} paper(s) agree{h.discordant ? `, ${h.discordant} disagree` : ""}</div></td>
                  <td><button className="btn secondary small" onClick={() => setOpen(open === key ? null : key)}>{open === key ? "Hide" : "Details"}</button></td>
                </tr>,
                open === key && (
                  <tr key={`${key}-d`}><td colSpan={8} style={{ background: "var(--panel)" }}>
                    <dl className="facts">
                      <dt>Lead study sample</dt><dd>{h.sample || "not reported"}</dd>
                      <dt>Associations grouped</dt><dd>{h.nAssocs} genome-wide significant association(s) for this trait at this variant</dd>
                      <dt>Lead record</dt><dd><a href={`https://www.ebi.ac.uk/gwas/variants/${h.rsid}`} target="_blank" rel="noreferrer">GWAS Catalog: {h.rsid}</a> · <a href={`https://pubmed.ncbi.nlm.nih.gov/${h.leadPmid}/`} target="_blank" rel="noreferrer">PMID {h.leadPmid}</a></dd>
                      <dt>Interpretation</dt><dd>{h.copies == null ? "Allele copies were not counted (see notes)." : `You carry ${h.copies} cop${h.copies === 1 ? "y" : "ies"} of the reported allele.`} This is a relative, population-level association; no absolute risk is implied.</dd>
                    </dl>
                    {h.notes.length > 0 && <ul className="limits">{h.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                    <PapersList groups={(file) => [{ ...LABELS.gwas, pmids: h.pmids }, { ...LABELS.litvar, pmids: file?.litvar[h.rsid] ?? [] }]} />
                  </td></tr>
                ),
              ];
            })}
            {!view.length && <tr><td colSpan={8}>No associations match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="btn-row no-print" style={{ marginTop: 10 }}>
        <button className="btn secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page + 1} of {pages} · {rows.length.toLocaleString()} rows</span>
        <button className="btn secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { EvidenceBundle, GeneArea, GeneResult, GeneVerdict, Report, SourcedQuote } from "../core/types";
import { siteLine } from "../core/genes";
import type { Go } from "./Shell";

const AREAS: { id: GeneArea | "all"; label: string }[] = [
  { id: "all", label: "All genes" },
  { id: "traits", label: "Traits" },
  { id: "nutrition", label: "Food & nutrients" },
  { id: "fitness", label: "Fitness & weight" },
  { id: "metabolic", label: "Metabolic" },
  { id: "heart", label: "Heart" },
  { id: "medicines", label: "Medicines" },
];

/** Does your genotype change what to do? One plain answer per verdict. */
export const VERDICT: Record<GeneVerdict, { label: string; chip: string; order: number }> = {
  "changes-advice": { label: "Your DNA can change the advice", chip: "conf-higher", order: 0 },
  limited: { label: "Some genotype-specific evidence", chip: "conf-moderate", order: 1 },
  "test-instead": { label: "A blood test answers this better", chip: "conf-moderate", order: 2 },
  "same-advice": { label: "Same advice whatever your DNA", chip: "conf-low", order: 3 },
  "no-proven-action": { label: "Affects a level; no proven action", chip: "conf-low", order: 4 },
  trait: { label: "Just a trait", chip: "conf-low", order: 5 },
};

const POP: Record<string, string> = { EUR: "European", AFR: "African", EAS: "East Asian", SAS: "South Asian", AMR: "admixed American" };
const pct = (x: number) => (x < 0.001 ? "under 0.1%" : `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`);

function freqLine(f: Record<string, number> | null, allele: string): string | null {
  if (!f || f.ALL == null) return null;
  const pops = Object.entries(f).filter(([k]) => k !== "ALL").sort((a, b) => b[1] - a[1]);
  const hi = pops[0], lo = pops[pops.length - 1];
  return `${allele} makes up ${pct(f.ALL)} of copies worldwide in 1000 Genomes${hi && lo && hi[1] - lo[1] > 0.1 ? ` (from ${pct(lo[1])} in ${POP[lo[0]]} to ${pct(hi[1])} in ${POP[hi[0]]} samples)` : ""}.`;
}

function Evidence({ quotes }: { quotes: SourcedQuote[] }) {
  if (!quotes.length) return null;
  return (
    <ul className="plain-list quotes">
      {quotes.map((q) => (
        <li key={q.quote}><b>{q.value}.</b> “{q.quote}” <a href={q.source.url} target="_blank" rel="noreferrer">{q.citation}</a></li>
      ))}
    </ul>
  );
}

function GeneCard({ r, report, go, focused }: { r: GeneResult; report: Report; go: Go; focused: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) { setOpen(true); ref.current?.scrollIntoView({ block: "center" }); } }, [focused]);
  const e = r.entry, v = VERDICT[e.verdict];
  const actions = (e.interventions ?? []).map((id) => report.interventions.find((a) => a.intervention.id === id)).filter(Boolean);
  return (
    <article ref={ref} className={`card gene-card ${r.reading?.tone === "notable" ? "notable" : ""} ${focused ? "focused" : ""}`} id={`gene-${e.id}`}>
      <div className="rec-head">
        <h3>{e.title}</h3>
        <span className="chip mono">{e.gene}</span>
        <span style={{ flex: 1 }} />
        <span className={`chip ${v.chip}`}>{v.label}</span>
      </div>
      <p className="plain gene-reading">
        {r.status === "not-tested" ? "Not on your chip, so there is no reading. That isn't a negative result." : r.reading?.text ?? "Only some of this gene's sites could be read from your file (see below), so no reading is given."}
      </p>
      <p className="gene-sites mono">{r.sites.map((s, i) => siteLine(s, e.sites[i].alleleName, e.sites[i].allele)).join(" · ")}</p>
      <p className="gene-verdict"><b>What it means for what you do:</b> {e.verdictNote}</p>
      {e.actions?.map((a) => <p key={a} className="highlight">{a}</p>)}
      {actions.length > 0 && (
        <p className="gene-actions no-print">
          {actions.map((a) => <button key={a!.intervention.id} className="linklike" onClick={() => go({ tab: "summary", id: `action-${a!.intervention.id}` })}>See: {a!.intervention.name} →</button>)}
        </p>
      )}
      {!actions.length && (e.interventions?.length ?? 0) > 0 && r.status !== "not-tested" && <p className="muted small-print">The related action item doesn't apply to your genotype.</p>}
      <button className="linklike no-print" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide the science" : "What this gene does, and the evidence"}</button>
      {open && (
        <div className="gene-more">
          <p className="plain">{e.what}</p>
          <Evidence quotes={e.evidence} />
          <ul className="plain-list small">
            {e.sites.map((s) => { const f = freqLine(s.freq, s.allele); return f ? <li key={s.rsid}>{s.rsid}: {f}</li> : null; })}
            {e.sites.map((s) => s.gwasPubs != null && <li key={`g${s.rsid}`}>{s.rsid}: {s.gwasPubs} genome-wide significant GWAS Catalog paper{s.gwasPubs === 1 ? "" : "s"}{s.gwasTraits.length ? ` (e.g. ${s.gwasTraits.slice(0, 3).join("; ")})` : ""}.</li>)}
            {e.strandNote && <li>DNA strand: {e.strandNote}</li>}
            {e.caveat && <li>Limits: {e.caveat}</li>}
          </ul>
        </div>
      )}
    </article>
  );
}

/** Genes often used for diet or fitness advice, with how much genome-wide evidence exists for each. */
function Marketed({ bundle, report }: { bundle: EvidenceBundle; report: Report }) {
  const g = bundle.geneGuide!;
  const byRs = useMemo(() => new Map((report.genesUnsupported ?? []).map((u) => [u.rsid, u.match] as const)), [report.genesUnsupported]);
  return (
    <details className="panel" style={{ marginTop: 18 }}>
      <summary>Genes often used in DNA diet and fitness reports ({g.unsupported.length}): how much evidence is there?</summary>
      <p className="plain" style={{ marginTop: 10 }}>
        You may see these in other DNA diet or fitness reports. For each one, the table shows your genotype and how many genome-wide studies (p &lt; 5×10⁻⁸, GWAS Catalog) found any association at that site, and for what.
        No verified trial in this app shows that changing diet, supplements or training by these genotypes helps, so none of them lead to advice here.
      </p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Gene</th><th>Site</th><th>Sometimes used to suggest</th><th>Your genotype</th><th>Genome-wide evidence at this site</th></tr></thead>
          <tbody>
            {g.unsupported.map((u) => {
              const match = byRs.get(u.rsid);
              const geno = !match ? "—" : match.status === "matched" ? match.forwardAlleles.join("") : match.status === "not-on-array" ? "not on chip" : match.status === "no-call" ? "no-call" : "unreadable";
              return (
                <tr key={u.rsid}>
                  <td className="mono">{u.gene}</td><td className="mono">{u.rsid}</td><td>{u.claim}</td><td className="mono">{geno}</td>
                  <td>{u.gwasPubs == null ? "GWAS data not loaded" : u.gwasPubs === 0 ? "None: no genome-wide significant association for any trait" : `${u.gwasPubs} paper${u.gwasPubs === 1 ? "" : "s"}: ${u.gwasTraits.slice(0, 3).join("; ")}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** What the file can and can't tell you, in plain words. */
function FileLimits({ report }: { report: Report }) {
  const genes = report.genes ?? [];
  const read = genes.filter((g) => g.status === "read").length, notOn = genes.filter((g) => g.status === "not-tested").length;
  return (
    <details className="panel" style={{ marginTop: 18 }}>
      <summary>What an AncestryDNA or 23andMe file can and can't tell you</summary>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div>
          <h4>It can</h4>
          <ul className="plain-list">
            <li>Read common single-letter DNA differences (SNPs) like the ones above: {read} of {genes.length} genes in this guide were fully read from your file{notOn ? `, ${notOn} weren't on your chip` : ""}.</li>
            <li>Show well-established traits (earwax, bitter taste, eye colour), how you process some nutrients, and a few genotypes where trials or guidelines give specific advice.</li>
            <li>Give hints about blood levels (vitamin D, B12, iron, Lp(a)) that a blood test then measures properly.</li>
          </ul>
        </div>
        <div>
          <h4>It can't</h4>
          <ul className="plain-list">
            <li>Measure anything epigenetic (methylation) or how active your genes are: the file is DNA letters only.</li>
            <li>Count copies of whole genes or stretches of DNA, such as the starch gene AMY1 or deletions of GSTM1 and GSTT1.</li>
            <li>Reliably detect very rare variants: consumer chips often misread them (see the chip-accuracy note in your results).</li>
            <li>Tell you what you will develop. Most traits and conditions depend on many genes plus diet, activity, sleep and environment.</li>
          </ul>
        </div>
      </div>
    </details>
  );
}

export function GeneGuideSection({ report, bundle, go, showSensitive, focus }: { report: Report; bundle: EvidenceBundle; go: Go; showSensitive: boolean; focus?: string }) {
  const [area, setArea] = useState<GeneArea | "all">("all");
  const [verdict, setVerdict] = useState<GeneVerdict | "all" | "act">("all");
  const [q, setQ] = useState("");
  const results = useMemo(() => (report.genes ?? []).filter((r) => showSensitive || !r.entry.sensitive), [report.genes, showSensitive]);
  const counts = useMemo(() => { const c: Record<string, number> = { all: results.length }; for (const r of results) c[r.entry.area] = (c[r.entry.area] ?? 0) + 1; return c; }, [results]);
  if (!bundle.geneGuide || !results.length) return null;
  const needle = q.trim().toLowerCase();
  const shown = results
    .filter((r) => area === "all" || r.entry.area === area)
    .filter((r) => verdict === "all" || (verdict === "act" ? ["changes-advice", "limited", "test-instead"].includes(r.entry.verdict) : r.entry.verdict === verdict))
    .filter((r) => !needle || [r.entry.title, r.entry.gene, r.entry.what, ...r.entry.sites.map((s) => s.rsid)].join(" ").toLowerCase().includes(needle))
    .sort((a, b) => Number(a.status === "not-tested") - Number(b.status === "not-tested") || VERDICT[a.entry.verdict].order - VERDICT[b.entry.verdict].order || Number(b.reading?.tone === "notable") - Number(a.reading?.tone === "notable"));
  return (
    <section className="block" id="genes">
      <div className="section-head"><h2 style={{ margin: 0 }}>Traits &amp; genes</h2>
        <p>Well-studied genes your file can read, one card each: what your DNA shows, what it means, and whether it actually changes what you should do. Every statement is checked word-for-word against its source.</p></div>
      <div className="filterbar no-print" role="search" style={{ position: "static" }}>
        <div className="seg" role="tablist" aria-label="Area">
          {AREAS.filter((a) => a.id === "all" || counts[a.id]).map((a) => (
            <button key={a.id} role="tab" aria-selected={area === a.id} className={`seg-btn ${area === a.id ? "on" : ""}`} onClick={() => setArea(a.id)}>{a.label} <span className="count">{counts[a.id] ?? 0}</span></button>
          ))}
        </div>
        <div className="filter-row">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search genes: e.g. MTHFR, caffeine, vitamin D, rs1801133" aria-label="Search genes" />
          <label>Show
            <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
              <option value="all">Everything</option>
              <option value="act">Only where DNA or a test changes what to do</option>
              {Object.entries(VERDICT).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div style={{ marginTop: 14 }} className="gene-grid">
        {shown.map((r) => <GeneCard key={r.entry.id} r={r} report={report} go={go} focused={focus === `gene-${r.entry.id}`} />)}
        {!shown.length && <p className="plain">No genes match these filters.</p>}
      </div>
      {bundle.geneGuide.notes.map((n) => (
        <details key={n.id} className="panel" style={{ marginTop: 18 }}>
          <summary>{n.title}</summary>
          <p className="plain" style={{ marginTop: 10 }}>{n.text}</p>
          <Evidence quotes={n.evidence} />
        </details>
      ))}
      <Marketed bundle={bundle} report={report} />
      <FileLimits report={report} />
    </section>
  );
}

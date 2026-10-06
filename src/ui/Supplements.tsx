import { useEffect, useMemo, useRef, useState } from "react";
import type { EvidenceBundle, Report, SiteMatch, SourcedQuote, SupplementResult } from "../core/types";
import { mapLine, matchesSupplement, supplementResults, VERDICT_LABEL, verdictLine } from "../core/supplements";
import type { Go } from "./Shell";

function Quotes({ quotes }: { quotes: SourcedQuote[] }) {
  if (!quotes.length) return null;
  return (
    <ul className="plain-list quotes">
      {quotes.map((q) => <li key={q.quote}><b>{q.value}.</b> “{q.quote}” <a href={q.source.url} target="_blank" rel="noreferrer">{q.citation}</a></li>)}
    </ul>
  );
}

const genotype = (m?: SiteMatch) =>
  !m ? "—" : m.status === "matched" ? m.forwardAlleles.join("") : m.status === "not-on-array" ? "not on chip" : m.status === "no-call" ? "no-call" : "unreadable";

/** How much has been published on this supplement × each gene, and the top trials, screened automatically. */
function LiteratureMap({ r }: { r: SupplementResult }) {
  return (
    <div className="supp-map">
      <h4>What's been studied: {r.entry.name} and genes</h4>
      <p className="muted small-print">
        PubMed records that mention this supplement, the gene and a genetic variant. Counts are a measure of how much research exists, not of whether it works.
        Top trials are screened automatically. "Compares genotypes" means the abstract describes a genotype-by-supplement comparison, not that a difference was found. None of this is verified, and none of it feeds the advice above.
      </p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Gene</th><th>Papers</th><th>Trials</th><th>Reviews</th><th>Top trials in humans that compare genotypes</th></tr></thead>
          <tbody>
            {r.entry.map.map((m) => (
              <tr key={m.gene}>
                <td className="mono"><a href={`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(m.query)}`} target="_blank" rel="noreferrer">{m.gene}</a></td>
                <td>{m.total.toLocaleString("en-US")}</td><td>{m.trials.toLocaleString("en-US")}</td><td>{m.reviews.toLocaleString("en-US")}</td>
                <td>{m.screened.length ? `${m.humanInteraction} of the top ${m.screened.length}` : "No trials"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.entry.map.some((m) => m.screened.length > 0) && (
        <details style={{ marginTop: 8 }}>
          <summary>Read the top trials</summary>
          <ul className="plain-list small">
            {r.entry.map.flatMap((m) => m.screened.map((c) => (
              <li key={m.gene + c.pmid}>
                <span className="mono">{m.gene}</span> · <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> <span className="muted">({c.journal} {c.year})</span>
                {c.humans && c.mentionsGeneInteraction && <span className="chip conf-moderate" style={{ marginLeft: 6 }}>compares genotypes</span>}
                {c.flags.length > 0 && <span className="muted"> · {c.flags.join("; ")}</span>}
              </li>
            )))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SupplementCard({ r, report, bundle, go, focused }: { r: SupplementResult; report: Report; bundle: EvidenceBundle; go: Go; focused: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) { setOpen(true); ref.current?.scrollIntoView({ block: "center" }); } }, [focused]);
  const e = r.entry, v = VERDICT_LABEL[r.verdict];
  const yours = new Map((report.genesUnsupported ?? []).map((u) => [u.rsid, u.match] as const));
  const marketed = (bundle.geneGuide?.unsupported ?? []).filter((u) => e.marketed.includes(u.rsid));
  return (
    <article ref={ref} className={`card supp-card ${r.verdict === "dna-changes" ? "notable" : ""} ${focused ? "focused" : ""}`} id={`supp-${e.id}`}>
      <div className="rec-head">
        <h3>{e.name}</h3>
        <span style={{ flex: 1 }} />
        <span className={`chip ${v.chip}`}>{v.label}</span>
      </div>
      <p className="plain supp-verdict">{verdictLine(r)}</p>

      <dl className="supp-qa">
        <dt>Does it work for anyone?</dt>
        <dd>{e.generalNote}</dd>

        <dt>Does your DNA change that?</dt>
        <dd>
          {r.genes.length === 0 && <span>No well-studied gene in this report bears on {e.name}.</span>}
          {r.genes.map((g) => (
            <p key={g.entry.id} className="supp-gene">
              <b>{g.entry.title}</b> <span className="mono muted">({g.entry.gene})</span>:{" "}
              {g.status === "not-tested" ? "not on your chip." : g.reading?.text ?? "only partly read from your file."}{" "}
              <button className="linklike no-print" onClick={() => go({ tab: "summary", id: `gene-${g.entry.id}` })}>Show this gene</button>
            </p>
          ))}
          {r.actions.map((a) => (
            <p key={a.intervention.id} className="highlight">
              For you: <button className="linklike" onClick={() => go({ tab: "summary", id: `action-${a.intervention.id}` })}>{a.intervention.name} →</button>
            </p>
          ))}
          {marketed.length > 0 && (
            <p className="muted small-print">
              Sometimes marketed for {e.name}: {marketed.map((u) => `${u.gene} ${u.rsid} (you: ${genotype(yours.get(u.rsid))})`).join(", ")}. No verified trial shows that changing what you take by these genotypes helps.
            </p>
          )}
        </dd>

        <dt>Is it safe?</dt>
        <dd>
          {e.safety.upperLimit
            ? <span><b>Upper limit:</b> {e.safety.upperLimit.value} <span className="muted">({e.safety.upperLimit.citation})</span>.</span>
            : <span>No upper limit could be verified from the sources this app uses.</span>}
          {e.safety.cautions.length > 0 && <ul className="plain-list small">{e.safety.cautions.map((c) => <li key={c.quote}>{c.value}.</li>)}</ul>}
        </dd>
      </dl>

      <button className="linklike no-print" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide the evidence" : "The evidence, and what's been studied"}</button>
      {open && (
        <div className="gene-more">
          <p className="plain">{e.what}</p>
          <h4>Does it work for anyone?</h4>
          <Quotes quotes={e.general} />
          {(e.safety.upperLimit || e.safety.cautions.length > 0) && <><h4>Safety</h4><Quotes quotes={[...(e.safety.upperLimit ? [e.safety.upperLimit] : []), ...e.safety.cautions]} /></>}
          <LiteratureMap r={r} />
        </div>
      )}
      {!open && <p className="muted small-print supp-mapline">Studied with: {e.map.map(mapLine).join(" · ")}</p>}
    </article>
  );
}

export function SupplementsSection({ report, bundle, go, showSensitive, focus }: { report: Report; bundle: EvidenceBundle; go: Go; showSensitive: boolean; focus?: string }) {
  const [q, setQ] = useState("");
  const [onlyDna, setOnlyDna] = useState(false);
  const results = useMemo(() => supplementResults(bundle, report, showSensitive), [bundle, report, showSensitive]);
  if (!results.length) return null;
  const shown = results
    .filter((r) => matchesSupplement(r, q))
    .filter((r) => !onlyDna || r.verdict === "dna-changes" || r.verdict === "test-first")
    .sort((a, b) => VERDICT_LABEL[a.verdict].order - VERDICT_LABEL[b.verdict].order || a.entry.name.localeCompare(b.entry.name));
  const counts = results.filter((r) => r.verdict === "dna-changes" || r.verdict === "test-first").length;
  return (
    <section className="block" id="supplements">
      <div className="section-head"><h2 style={{ margin: 0 }}>Supplements &amp; your DNA</h2>
        <p>Common supplements, one card each, answering three questions: does it work for anyone, does your DNA change that, and is it safe. The answers come from human trials and reviews, checked word-for-word against their sources. This isn't a recommendation to take anything; a pharmacist or doctor can tell you how a supplement fits with your health and medicines.</p></div>
      <div className="filterbar no-print" role="search" style={{ position: "static" }}>
        <div className="filter-row">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: e.g. fish oil, vitamin D, B12, MTHFR" aria-label="Search supplements" />
          <label><input type="checkbox" checked={onlyDna} onChange={(e) => setOnlyDna(e.target.checked)} /> Only where your DNA or a blood test matters ({counts})</label>
        </div>
      </div>
      <div style={{ marginTop: 14 }} className="gene-grid">
        {shown.map((r) => <SupplementCard key={r.entry.id} r={r} report={report} bundle={bundle} go={go} focused={focus === `supp-${r.entry.id}`} />)}
        {!shown.length && <p className="plain">No supplements match.</p>}
      </div>
    </section>
  );
}

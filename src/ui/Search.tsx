import { useDeferredValue, useMemo } from "react";
import type { Report } from "../core/types";
import type { Summary } from "../core/plain";
import { searchReport, type SearchGroup } from "../core/search";
import type { Go } from "./Shell";

const ORDER: SearchGroup[] = ["Your summary", "Actions", "Curated results", "Rare disease variants", "Trait associations"];
const EXAMPLES = ["BRCA1", "cystic fibrosis", "caffeine", "type 2 diabetes", "cholesterol", "iron", "height", "rs1800562"];

export function SearchView({ report, summary, query, onQuery, showSensitive, go }: {
  report: Report; summary: Summary; query: string; onQuery: (q: string) => void; showSensitive: boolean; go: Go;
}) {
  const q = useDeferredValue(query);
  const hits = useMemo(() => searchReport(report, summary, q, { showSensitive }), [report, summary, q, showSensitive]);
  return (
    <div className="wrap">
      <section className="block">
        <div className="section-head"><h2 style={{ margin: 0 }}>Search your results</h2>
          <p>Search genes, conditions, traits, rsIDs or actions. Results are in plain language; open the technical details for the numbers and the papers.</p></div>
        <input className="bigsearch-input" type="search" autoFocus value={query} onChange={(e) => onQuery(e.target.value)} placeholder="e.g. BRCA1, celiac, caffeine, rs1800562" aria-label="Search your results" />
        {query.trim().length < 2 && (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <span className="muted">Try:</span>
            {EXAMPLES.map((e) => <button key={e} className="btn secondary small" onClick={() => onQuery(e)}>{e}</button>)}
          </div>
        )}
        {query.trim().length >= 2 && !hits.length && <p className="plain" style={{ marginTop: 16 }}>Nothing in your report matches "{query}". If it's a gene, it may have no known disease-causing variants on consumer chips.</p>}
        {ORDER.map((g) => {
          const gh = hits.filter((h) => h.group === g);
          if (!gh.length) return null;
          return (
            <div key={g} style={{ marginTop: 24 }}>
              <h3>{g} <span className="muted">({gh.length})</span></h3>
              {gh.map((h, i) => (
                <article key={g + h.title + i} className="card search-hit">
                  <b>{h.title}</b>
                  <p className="plain" style={{ margin: "4px 0 8px" }}>{h.plain}</p>
                  <button className="btn secondary small" onClick={() => go(h.target.tab === "summary" ? { tab: "summary", id: h.target.id } : { tab: "appendix", section: h.target.section, query: h.target.query })}>
                    {h.target.tab === "summary" ? "Open in summary →" : "Technical details →"}
                  </button>
                </article>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}

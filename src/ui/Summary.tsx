import { useEffect, useRef } from "react";
import type { Report, UserContext } from "../core/types";
import type { Summary, SummaryItem, Tone } from "../core/plain";
import { DISCLAIMER } from "../core/export";
import { ContextForm } from "./ContextForm";
import type { Go } from "./Shell";

const GROUPS: { tone: Tone; title: string; intro: string; key: string }[] = [
  { tone: "quality", title: "Check your file", intro: "", key: "clinical" },
  { tone: "confirm", title: "Confirm with a doctor", intro: "Possible findings that matter for health if they are real. Consumer chips make mistakes, so each needs a clinical test before it means anything.", key: "clinical" },
  { tone: "action", title: "Things you could do", intro: "Food, lifestyle and questions for your clinician, each backed by verified studies. Each one says whether your genes actually change the advice (usually they don't).", key: "action" },
  { tone: "know", title: "Good to know", intro: "Common variants with small, well-replicated effects, and medication-response notes. Interesting, but none of these is a diagnosis.", key: "disease" },
  { tone: "clear", title: "Checked and not found", intro: "Well-known variants that were tested and not seen. This can't rule out a condition.", key: "none" },
];

const CONF: Record<SummaryItem["confidence"], string> = { higher: "Stronger evidence", moderate: "Moderate evidence", low: "Weak or uncertain" };

function Card({ item, go, focused }: { item: SummaryItem; go: Go; focused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "center" }); }, [focused]);
  return (
    <article ref={ref} id={item.id} className={`card summary-card ${focused ? "focused" : ""}`}>
      {item.tone !== "quality" && item.tone !== "clear" && <div className="chips"><span className={`chip conf-${item.confidence}`}>{CONF[item.confidence]}</span></div>}
      <h3>{item.title}</h3>
      <p className="plain">{item.plain}</p>
      {item.list && <ul className="plain-list">{item.list.map((l) => <li key={l}>{l}</li>)}</ul>}
      <div className="why-next">
        <div>
          <h4>What you could do</h4>
          <ul>{item.next.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
        <div>
          <h4>Why you're seeing this</h4>
          <ul>{item.why.filter(Boolean).map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      </div>
      <div className="card-foot no-print">
        {item.sources.slice(0, 4).map((s) => <a key={s.url + s.label} href={s.url} target="_blank" rel="noreferrer">{s.label}</a>)}
        <span style={{ flex: 1 }} />
        <button className="btn secondary small" onClick={() => go({ tab: "appendix", section: item.appendix.section, query: item.appendix.query })}>Technical details →</button>
      </div>
    </article>
  );
}

export function SummaryView({ summary, report, fileName, context, onContext, go, focus }: {
  summary: Summary; report: Report; fileName: string; context: UserContext; onContext: (c: UserContext) => void; go: Go; focus?: string;
}) {
  const hidden = report.clinical.concat().some((f) => f.match.site.sensitive);
  return (
    <div className="wrap">
      <section className="block summary-top">
        <p className="muted" style={{ margin: 0 }}>Your report · {fileName} · {report.file.format === "23andme" ? "23andMe" : "AncestryDNA"}</p>
        <h2 className="summary-headline">{summary.headline}</h2>
        <form className="bigsearch no-print" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get("q") as string; go({ tab: "search", query: q }); }}>
          <input name="q" type="search" placeholder="Search anything: a gene (BRCA1), a condition (celiac), a trait (caffeine), an rsID…" aria-label="Search your results" />
          <button className="btn" type="submit">Search</button>
        </form>
        <p className="muted small-print">
          {DISCLAIMER[0]} {DISCLAIMER[2]} <button className="linklike" onClick={() => go({ tab: "appendix", section: "all" })}>More about limits and sources</button>
        </p>
      </section>

      {GROUPS.map((g) => {
        const items = summary.items.filter((i) => i.tone === g.tone);
        if (!items.length && g.tone !== "confirm" && g.tone !== "action") return null;
        return (
          <section key={g.tone} className={`block key-${g.key}`}>
            <div className="section-head"><h2 style={{ margin: 0 }}>{g.title}</h2>{g.intro && <p>{g.intro}</p>}</div>
            {items.map((i) => <Card key={i.id} item={i} go={go} focused={focus === i.id} />)}
            {!items.length && g.tone === "confirm" && <div className="card key-none"><p className="plain" style={{ margin: 0 }}>Nothing was flagged for a doctor. This can't rule out a condition, because chips test only a small part of your DNA.</p></div>}
            {!items.length && g.tone === "action" && <div className="card key-none"><p className="plain" style={{ margin: 0 }}>No evidence-based personalized action. General health advice from your clinician still applies.</p></div>}
          </section>
        );
      })}

      <section className="block">
        <div className="section-head"><h2 style={{ margin: 0 }}>Make it more relevant (optional)</h2>
          <p>Adding medications, diagnoses or diet lets the report flag interactions and conflicts. It never turns your DNA into medical advice, and nothing is stored.</p></div>
        <ContextForm value={context} onChange={onContext} notes={report.contextNotes} />
        {hidden && <p className="muted">Some sensitive results (APOE / Alzheimer disease) are hidden. Use "Sensitive results" at the top if you want to see them.</p>}
      </section>
    </div>
  );
}

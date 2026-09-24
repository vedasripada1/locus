import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Report, UserContext } from "../core/types";
import { SUFFICIENT_RULES, type Category, type Summary, type SummaryItem } from "../core/plain";
import { searchReport, type SearchHit } from "../core/search";
import { DISCLAIMER } from "../core/export";
import { ContextForm } from "./ContextForm";
import type { Go } from "./Shell";

const CATS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "diet", label: "Diet" },
  { id: "supplement", label: "Supplements" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "clinician", label: "Ask your doctor" },
  { id: "health", label: "Health findings" },
  { id: "medication", label: "Medications" },
  { id: "trait", label: "Traits & risks" },
  { id: "clear", label: "Checked" },
];
const TYPE_LABEL: Partial<Record<Category, string>> = { diet: "Food", supplement: "Supplement", lifestyle: "Lifestyle", clinician: "Ask your doctor", health: "Health finding", medication: "Medication", trait: "Trait", clear: "Checked", quality: "File" };
const RECS: Category[] = ["diet", "supplement", "lifestyle"];

/** Search hits that add something beyond the item list (coverage answers, trait groups, curated site status). */
function extraHits(hits: SearchHit[]): (SearchHit & { category: Category })[] {
  return hits
    .filter((h) => h.group !== "Your summary" && h.group !== "Actions")
    .map((h) => ({ ...h, category: (h.group === "Trait associations" ? "trait" : h.group === "Rare disease variants" ? "health" : h.target.tab === "appendix" && h.target.section === "clinical" ? "health" : "trait") as Category }));
}

function Details({ item, go }: { item: SummaryItem; go: Go }) {
  return (
    <div className="why-next">
      <div>
        <h4>What you could do</h4>
        <ul>{item.next.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
      <div>
        <h4>Why you're seeing this</h4>
        <ul>{item.why.filter(Boolean).map((w) => <li key={w}>{w}</li>)}</ul>
        {item.list && <ul>{item.list.map((l) => <li key={l}>{l}</li>)}</ul>}
      </div>
      <div className="card-foot" style={{ gridColumn: "1 / -1" }}>
        {item.sources.slice(0, 4).map((s) => <a key={s.url + s.label} href={s.url} target="_blank" rel="noreferrer">{s.label}</a>)}
        <span style={{ flex: 1 }} />
        <button className="btn secondary small" onClick={() => go({ tab: "appendix", section: item.appendix.section, query: item.appendix.query })}>Technical details →</button>
      </div>
    </div>
  );
}

/** Upfront, easy-read list of diet, supplement and lifestyle steps with sufficient evidence. */
function Recommendations({ items, hiddenWeak, go }: { items: SummaryItem[]; hiddenWeak: number; go: Go }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="block key-action">
      <div className="section-head"><h2 style={{ margin: 0 }}>Diet &amp; supplements</h2>
        <p>Steps backed by randomized trials, meta-analyses or guidelines that relate to your results. Most work the same whatever your genes; each card says when they don't.</p></div>
      {!items.length && <div className="card key-none"><p className="plain" style={{ margin: 0 }}>No diet or supplement change is supported by sufficient evidence for your results. General healthy-eating advice still applies.</p></div>}
      <div className="recs">
        {items.map((i) => (
          <article key={i.id} className="rec card" id={i.id}>
            <div className="rec-head">
              <span className={`chip type-${i.category}`}>{TYPE_LABEL[i.category]}</span>
              <h3>{i.title}</h3>
            </div>
            <p className="plain">{i.plain}</p>
            <dl className="rec-facts">
              <div><dt>Why you</dt><dd>{i.whyYou}</dd></div>
              <div><dt>Evidence</dt><dd>{i.evidenceLabel}</dd></div>
              <div><dt>Does your DNA change it?</dt><dd>{i.dnaMatters}</dd></div>
              {i.caution && <div><dt>Limit / caution</dt><dd>{i.caution}</dd></div>}
            </dl>
            <button className="linklike no-print" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>{open === i.id ? "Hide details" : "Why and what to do"}</button>
            {open === i.id && <Details item={i} go={go} />}
          </article>
        ))}
      </div>
      {hiddenWeak > 0 && <p className="muted" style={{ fontSize: ".9rem" }}>{hiddenWeak} more diet, supplement or lifestyle item{hiddenWeak === 1 ? " has" : "s have"} weaker evidence and {hiddenWeak === 1 ? "is" : "are"} hidden. Choose "Include weaker evidence" below to see {hiddenWeak === 1 ? "it" : "them"}.</p>}
    </section>
  );
}

function ItemRow({ item, go, focused }: { item: SummaryItem; go: Go; focused: boolean }) {
  const [open, setOpen] = useState(focused);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (focused) { setOpen(true); ref.current?.scrollIntoView({ block: "center" }); } }, [focused]);
  return (
    <article ref={ref} id={item.id} className={`card result-row ${focused ? "focused" : ""} ${item.sufficient ? "" : "weak"}`}>
      <div className="rec-head">
        <span className={`chip type-${item.category}`}>{TYPE_LABEL[item.category]}</span>
        <h3>{item.title}</h3>
        <span style={{ flex: 1 }} />
        <span className={`chip ${!item.sufficient ? "conf-low" : /unverified/.test(item.evidenceLabel) ? "conf-moderate" : "conf-higher"}`}>{item.sufficient ? item.evidenceLabel : `Weaker: ${item.evidenceLabel}`}</span>
      </div>
      <p className="plain" style={{ margin: "6px 0" }}>{item.plain}</p>
      <button className="linklike no-print" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide details" : "Why and what to do"}</button>
      {open && <Details item={item} go={go} />}
    </article>
  );
}

export function ResultsView({ summary, report, fileName, context, onContext, go, focus, showSensitive }: {
  summary: Summary; report: Report; fileName: string; context: UserContext; onContext: (c: UserContext) => void; go: Go; focus?: string; showSensitive: boolean;
}) {
  const [cat, setCat] = useState<Category | "all">("all");
  const [weaker, setWeaker] = useState(false);
  const [carried, setCarried] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());

  const items = summary.items;
  const recs = items.filter((i) => RECS.includes(i.category));
  const quality = items.filter((i) => i.category === "quality");
  const listable = items.filter((i) => i.category !== "quality");
  const matchesQ = (i: SummaryItem) => !q || [i.title, i.plain, i.whyYou, ...(i.list ?? [])].join(" ").toLowerCase().includes(q);
  const shown = listable.filter((i) => (cat === "all" || cat === i.category) && (weaker || i.sufficient) && (!carried || i.carried) && matchesQ(i));
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of listable) if ((weaker || i.sufficient) && (!carried || i.carried)) { c[i.category] = (c[i.category] ?? 0) + 1; c.all = (c.all ?? 0) + 1; }
    return c;
  }, [listable, weaker, carried]);
  const weakCount = listable.filter((i) => !i.sufficient).length;
  const extras = useMemo(() => (q.length >= 2 ? extraHits(searchReport(report, summary, q, { showSensitive })).filter((h) => cat === "all" || h.category === cat) : []), [q, cat, report, summary, showSensitive]);

  return (
    <div className="wrap">
      <section className="block summary-top">
        <p className="muted" style={{ margin: 0 }}>Your results · {fileName} · {report.file.format === "23andme" ? "23andMe" : "AncestryDNA"}</p>
        <h2 className="summary-headline">{summary.headline}</h2>
        <p className="muted small-print">
          Only results with sufficient evidence are shown unless you choose otherwise. {DISCLAIMER[0]} {DISCLAIMER[2]}{" "}
          <button className="linklike" onClick={() => go({ tab: "appendix", section: "all" })}>Limits, sources and full technical report</button>
        </p>
      </section>

      {quality.map((i) => <ItemRow key={i.id} item={i} go={go} focused={focus === i.id} />)}
      <Recommendations items={recs.filter((i) => i.sufficient)} hiddenWeak={recs.filter((i) => !i.sufficient).length} go={go} />

      <section className="block">
        <div className="section-head"><h2 style={{ margin: 0 }}>All your results</h2>
          <p>Pick a category, or search within it. Each result opens to show why it's there and what you could do.</p></div>
        <div className="filterbar no-print" role="search">
          <div className="seg" role="tablist" aria-label="Category">
            {CATS.map((c) => (
              <button key={c.id} role="tab" aria-selected={cat === c.id} className={`seg-btn ${cat === c.id ? "on" : ""}`} onClick={() => setCat(c.id)}>
                {c.label} <span className="count">{counts[c.id] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="filter-row">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={cat === "all" ? "Search: gene, condition, trait, food, rsID" : `Search within ${CATS.find((c) => c.id === cat)!.label.toLowerCase()}`} aria-label="Search results" />
            <label>Evidence
              <select value={weaker ? "all" : "sufficient"} onChange={(e) => setWeaker(e.target.value === "all")}>
                <option value="sufficient">Sufficient evidence only</option>
                <option value="all">Include weaker evidence ({weakCount})</option>
              </select>
            </label>
            <label><input type="checkbox" checked={carried} onChange={(e) => setCarried(e.target.checked)} /> Only things I carry</label>
          </div>
          {cat !== "all" && <p className="muted" style={{ fontSize: ".85rem", margin: "6px 0 0" }}>Sufficient evidence here means: {SUFFICIENT_RULES[cat]}</p>}
        </div>

        <div style={{ marginTop: 14 }}>
          {shown.map((i) => <ItemRow key={i.id} item={i} go={go} focused={focus === i.id} />)}
          {!shown.length && !extras.length && <p className="plain">Nothing matches these filters.{!weaker && weakCount ? " Try including weaker evidence." : ""}</p>}
        </div>
        {extras.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3>Also in your data <span className="muted">({extras.length})</span></h3>
            {extras.slice(0, 30).map((h, n) => (
              <article key={h.title + n} className="card result-row">
                <div className="rec-head"><span className={`chip type-${h.category}`}>{TYPE_LABEL[h.category]}</span><h3>{h.title}</h3></div>
                <p className="plain" style={{ margin: "6px 0" }}>{h.plain}</p>
                <button className="linklike" onClick={() => go(h.target.tab === "summary" ? { tab: "summary", id: h.target.id } : { tab: "appendix", section: h.target.section, query: h.target.query })}>Technical details</button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="block">
        <ContextForm value={context} onChange={onContext} notes={report.contextNotes} />
      </section>
    </div>
  );
}

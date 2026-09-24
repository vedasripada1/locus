import { useMemo, useState } from "react";
import type { EvidenceBundle, Report, UserContext } from "../core/types";
import { toJson, toMarkdown } from "../core/export";
import { summarize } from "../core/plain";
import { Appendix, download } from "./ReportView";
import { PapersProvider } from "./Papers";
import { SummaryView } from "./Summary";
import { SearchView } from "./Search";

type Tab = "summary" | "search" | "appendix";
export type Go = (t: { tab: "summary"; id?: string } | { tab: "search"; query?: string } | { tab: "appendix"; section: string; query?: string }) => void;

interface Props {
  report: Report; bundle: EvidenceBundle; fileName: string;
  context: UserContext; onContext: (c: UserContext) => void; onDelete: () => void;
}

/** Report layout: plain-language Summary first, Search across everything, technical Appendix last. */
export function ReportView({ report, bundle, fileName, context, onContext, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const [showSensitive, setShowSensitive] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | undefined>();
  const [appendix, setAppendix] = useState<{ section: string; query?: string; n: number }>({ section: "all", n: 0 });
  const summary = useMemo(() => summarize(report, { showSensitive }), [report, showSensitive]);
  const stamp = report.generatedAt.slice(0, 10);

  const go: Go = (t) => {
    if (t.tab === "summary") { setFocus(t.id); setTab("summary"); }
    if (t.tab === "search") { if (t.query != null) setQuery(t.query); setTab("search"); }
    if (t.tab === "appendix") { setAppendix((a) => ({ section: t.section, query: t.query, n: a.n + 1 })); setTab("appendix"); }
    window.scrollTo({ top: 0 });
  };
  const toggleSensitive = () => {
    if (showSensitive) return setShowSensitive(false);
    if (window.confirm("Show sensitive results (APOE / Alzheimer disease)?\n\nMany people choose not to learn these. They cannot tell you whether you will develop a disease. Consider genetic counselling first.")) setShowSensitive(true);
  };
  const confirmDelete = () => { if (window.confirm("Delete the loaded genotype data, your context entries and this report from this tab?")) onDelete(); };

  const tabs: [Tab, string][] = [["summary", "Summary"], ["search", "Search"], ["appendix", "Appendix (technical)"]];
  return (
    <PapersProvider bulkCites={report.bulk?.clinvar.cites ?? {}} gwasStudies={report.bulk?.gwas.studies ?? {}}>
      <nav className="tabs no-print" aria-label="Report sections">
        <div className="wrap">
          {tabs.map(([t, label]) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => { setFocus(undefined); setTab(t); }}>{label}</button>
          ))}
          <span style={{ flex: 1 }} />
          <label className="tab-tool"><input type="checkbox" checked={showSensitive} onChange={toggleSensitive} /> Sensitive results</label>
          <button className="btn secondary small" onClick={() => download(`genotype-report-${stamp}.md`, toMarkdown(report, bundle, { showSensitive }, summary), "text/markdown")}>Markdown</button>
          <button className="btn secondary small" onClick={() => download(`genotype-report-${stamp}.json`, toJson(report), "application/json")}>JSON</button>
          <button className="btn secondary small" onClick={() => window.print()}>Print</button>
          <button className="btn danger small" onClick={confirmDelete}>Delete my data</button>
        </div>
      </nav>
      {tab === "summary" && <SummaryView summary={summary} report={report} fileName={fileName} context={context} onContext={onContext} go={go} focus={focus} />}
      {tab === "search" && <SearchView report={report} summary={summary} query={query} onQuery={setQuery} showSensitive={showSensitive} go={go} />}
      {tab === "appendix" && (
        <Appendix key={appendix.n} report={report} bundle={bundle} fileName={fileName} showSensitive={showSensitive} onToggleSensitive={toggleSensitive}
          initialSection={appendix.section} explorerQuery={appendix.query} />
      )}
    </PapersProvider>
  );
}

import { useMemo, useState } from "react";
import type { EvidenceBundle, EvidenceStrength, Finding, InterventionAssessment, Report, SiteMatch } from "../core/types";
import { DISCLAIMER } from "../core/export";
import { FindingCard, InterventionCard } from "./Cards";
import { EvidenceTable, CoverageTable, LiteraturePanel, SourcesPanel } from "./Tables";
import { ClinVarScreen, GwasExplorer } from "./Bulk";
import { AccuracyPanel, RawDataTable } from "./RawData";

interface Props {
  report: Report; bundle: EvidenceBundle; fileName: string;
  showSensitive: boolean; onToggleSensitive: () => void;
  /** Section to open, and a query to pre-fill in the explorer (from Search or Summary links). */
  initialSection?: string; explorerQuery?: string;
}

export interface Filters { q: string; section: string; carriedOnly: boolean; minStrength: EvidenceStrength | "any"; showSensitive: boolean }
const RANK: Record<EvidenceStrength, number> = { strong: 4, moderate: 3, limited: 2, conflicting: 1, insufficient: 0 };

export const isSensitive = (f: Finding) =>
  f.kind === "gwas" || f.kind === "clinical" ? f.match.site.sensitive : f.kind === "composite" || f.topic.id === "alzheimers";

const carried = (f: Finding) =>
  f.kind === "clinical" ? (f.altCopies ?? 0) > 0 : f.kind === "gwas" ? (f.effectCopies ?? 0) > 0 : f.kind === "composite";

export function passes(f: Finding, fl: Filters): boolean {
  if (!fl.showSensitive && isSensitive(f)) return false;
  if (fl.carriedOnly && !carried(f)) return false;
  if (fl.minStrength !== "any") {
    if (f.kind !== "gwas" || RANK[f.strength] < RANK[fl.minStrength]) return false;
  }
  if (fl.q) {
    const hay = JSON.stringify(f.kind === "clinical" ? [f.record, f.match.site.label] : f.kind === "gwas" ? [f.topic.label, f.match.site, f.lead.reportedTrait] : [f.topic.label, f.headline]).toLowerCase();
    if (!hay.includes(fl.q.toLowerCase())) return false;
  }
  return true;
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The full technical report ("appendix"): every finding, table, source and audit entry. */
export function Appendix({ report, bundle, fileName, showSensitive, onToggleSensitive, initialSection, explorerQuery }: Props) {
  const [flState, setFl] = useState<Filters>({ q: "", section: initialSection ?? "all", carriedOnly: false, minStrength: "any", showSensitive: false });
  const fl = { ...flState, showSensitive };
  const set = (p: Partial<Filters>) => setFl((f) => ({ ...f, ...p }));
  const show = (s: string) => fl.section === "all" || fl.section === s;

  const actionable = report.clinical.filter((f) => f.category === "pathogenic-carried");
  const otherClinical = report.clinical.filter((f) => f.category !== "pathogenic-carried");
  const hiddenSensitive = [...report.disease, ...report.metabolism, ...report.clinical].filter(isSensitive).length;
  const f = <T extends Finding>(xs: T[]) => xs.filter((x) => passes(x, fl));
  const stamp = report.generatedAt.slice(0, 10);

  const stats = report.file.stats;
  const sections = useMemo(() => [
    ["all", "Everything"], ["clinical", "1 · Clinical"], ["disease", "2 · Disease"], ["metabolism", "3 · Metabolism"],
    ["performance", "4 · Performance"], ["actions", "5 · Actions"], ["explorer", "Explorer (all GWAS)"], ["table", "Evidence table"], ["literature", "Literature"], ["raw", "Your raw data"],
  ], []);

  const bulk = report.bulk;
  return (
    <>
      <div className="toolbar no-print">
        <div className="wrap">
          <label>Section
            <select value={fl.section} onChange={(e) => set({ section: e.target.value })}>
              {sections.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label>Evidence
            <select value={fl.minStrength} onChange={(e) => set({ minStrength: e.target.value as Filters["minStrength"] })}>
              <option value="any">Any strength</option><option value="strong">Strong only</option>
              <option value="moderate">Moderate or better</option><option value="limited">Limited or better</option>
            </select>
          </label>
          <label><input type="checkbox" checked={fl.carriedOnly} onChange={(e) => set({ carriedOnly: e.target.checked })} /> Only alleles I carry</label>
          <label><input type="checkbox" checked={showSensitive} onChange={onToggleSensitive} /> Sensitive results</label>
          <label className="visually-hidden" htmlFor="q">Search</label>
          <input id="q" type="search" placeholder="Search gene, rsID, trait" value={fl.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
      </div>

      <div className="wrap">
        <section className="block">
          <div className="section-head"><span className="section-num">A</span><h2 style={{ margin: 0 }}>Appendix: full technical report</h2>
            <p>Everything behind the summary: every finding with its genotype, alleles, effect sizes, study populations, sources, limitations and the papers for each allele.</p></div>
          <div className="grid-2">
            <div className="panel">
              <h3>Your file</h3>
              <dl className="facts">
                <dt>File</dt><dd>{fileName}</dd>
                <dt>Format</dt><dd>{report.file.format === "23andme" ? "23andMe" : "AncestryDNA"}</dd>
                <dt>Genome build</dt><dd>{report.file.build}</dd>
                <dt>Rows</dt><dd>{stats.totalRows.toLocaleString()} ({stats.noCallRows.toLocaleString()} no-calls)</dd>
                <dt>Call rate</dt><dd>{(stats.callRate * 100).toFixed(2)}%</dd>
              </dl>
              {report.file.issues.map((i) => (
                <div key={i.code} className={`notice ${i.severity === "warning" ? "alert" : ""}`} style={{ marginTop: 8 }}>
                  <span className={`chip ${i.severity === "warning" ? "warn" : ""}`}>{i.severity}</span> {i.message}
                </div>
              ))}
            </div>
            <div className="panel">
              <h3>Coverage of curated sites</h3>
              <div className="grid-3" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                <Stat n={report.coverage.matched} label="curated sites tested & readable" />
                <Stat n={report.coverage.notOnArray} label="not on your chip" />
                <Stat n={report.coverage.noCall} label="no-call" />
                <Stat n={report.coverage.mismatch} label="allele mismatch" />
              </div>
              {bulk && (
                <p style={{ fontSize: ".9rem" }}>
                  Genome-wide: <b>{bulk.clinvar.tested.toLocaleString()}</b> ClinVar pathogenic sites and <b>{bulk.gwas.tested.toLocaleString()}</b> GWAS Catalog sites were readable in your file.
                </p>
              )}
              {report.bulkError && <p className="muted" style={{ fontSize: ".9rem" }}>{report.bulkError}</p>}
              <p className="muted" style={{ fontSize: ".9rem", marginBottom: 0 }}>
                Untested sites are never treated as negative. See the coverage table at the end for each curated site.
              </p>
            </div>
          </div>
          <AccuracyPanel r={report} />
          <div className="notice alert" style={{ marginTop: 18 }}>
            <ul style={{ margin: 0 }}>{DISCLAIMER.map((d) => <li key={d}>{d}</li>)}</ul>
          </div>
          {!fl.showSensitive && hiddenSensitive > 0 && (
            <p className="muted no-print" style={{ marginTop: 12 }}>{hiddenSensitive} sensitive result(s) hidden (APOE / Alzheimer disease). Use "Sensitive results" in the toolbar to show them.</p>
          )}
        </section>

        {show("clinical") && (
          <Section n="1" keyName="clinical" title="Clinically significant findings requiring confirmation"
            intro="Rare variants that ClinVar classifies as pathogenic or likely pathogenic, observed in your file. Each needs confirmation by clinical-grade testing and discussion with a genetics professional before it means anything.">
            {f(actionable).length ? f(actionable).map((x) => <FindingCard key={x.record.id} f={x} />) : (
              <div className="card key-none"><p className="headline">No pathogenic or likely pathogenic allele among the tested curated sites.</p>
                <p className="muted" style={{ margin: 0 }}>Among the {bundle.sites.filter((s) => s.domain === "clinical").length} curated clinical sites. The genome-wide screen below covers every ClinVar pathogenic variant on your chip. Consumer chips cover a small fraction of disease-causing variants, so neither rules out any condition.</p></div>
            )}
            <details>
              <summary>Other ClinVar results: conflicting, uncertain, not carried, not tested ({f(otherClinical).length})</summary>
              <div style={{ marginTop: 12 }}>{f(otherClinical).map((x) => <FindingCard key={x.record.id} f={x} compact />)}</div>
            </details>
            {bulk && <ClinVarScreen bulk={bulk.clinvar} warning={bundle.warnings?.find((w) => w.id === "snp-chip-rare-variants")} showSensitive={fl.showSensitive} />}
          </Section>
        )}
        {show("disease") && (
          <Section n="2" keyName="disease" title="Common disease associations"
            intro="Common variants from genome-wide association studies (GWAS). They shift average odds slightly across populations. They are not diagnoses, and no absolute risk is calculated.">
            {f(report.disease).map((x, i) => <FindingCard key={i} f={x} />)}
          </Section>
        )}
        {show("metabolism") && (
          <Section n="3" keyName="metabolism" title="Metabolism" intro="Associations with nutrient levels, body size and how the body handles foods and alcohol. A blood test measures most of these directly and is more informative than genotype.">
            {f(report.metabolism).map((x, i) => <FindingCard key={i} f={x} />)}
          </Section>
        )}
        {show("performance") && (
          <Section n="4" keyName="performance" title="Performance" intro="Only genome-wide significant human associations are shown. Most variants marketed for training advice do not reach this bar.">
            {f(report.performance).map((x, i) => <FindingCard key={i} f={x} />)}
          </Section>
        )}
        {show("actions") && (
          <Section n="5" keyName="action" title="Possible actions to discuss"
            intro="Food and general guidance first. Each item says whether evidence shows it helps at all, and separately whether the effect differs by genotype. Supplements appear only with direct human trial evidence and a verified upper limit.">
            {report.interventions.filter((a) => fl.showSensitive || !a.triggeredBy.some((t) => /alzheimer/i.test(t)))
              .map((a: InterventionAssessment) => <InterventionCard key={a.intervention.id} a={a} />)}
            {!report.interventions.length && <div className="card key-none"><p className="headline">No evidence-based personalized action.</p></div>}
            {report.topicsWithoutAction.length > 0 && (
              <div className="card key-none">
                <h3>No evidence-based personalized action</h3>
                <p style={{ margin: 0 }}>For <b>{report.topicsWithoutAction.filter((t) => fl.showSensitive || !/alzheimer/i.test(t)).join(", ")}</b>, no verified evidence supports an action based on your genotype. General health guidance from your clinician still applies.</p>
              </div>
            )}
          </Section>
        )}
        {show("explorer") && bulk && (
          <Section n="◼" keyName="none" title="Explorer: every GWAS association in your file"
            intro="The curated sections above cover a small set of well-studied traits. This explorer lists every genome-wide significant GWAS Catalog association for variants in your file, with the studies behind each one.">
            <GwasExplorer bulk={bulk.gwas} initialQuery={explorerQuery} onCsv={(csv) => download(`gwas-associations-${stamp}.csv`, csv, "text/csv")} />
          </Section>
        )}
        {show("table") && (
          <Section n="◼" keyName="none" title="Evidence table" intro="Every association behind the findings above, with its source record.">
            <EvidenceTable report={report} filters={fl} />
          </Section>
        )}
        {show("literature") && (
          <Section n="◼" keyName="none" title="Literature review layer" intro="Human studies and reviews about foods, dietary patterns and supplements, retrieved from PubMed. These are auto-screened candidates, not verified claims: design is taken from PubMed publication types, and animal-only or mechanistic records are flagged.">
            <LiteraturePanel bundle={bundle} report={report} showSensitive={fl.showSensitive} />
          </Section>
        )}
        {show("raw") && (
          <Section n="◼" keyName="none" title="Your raw data" intro="Every row of your file as a table: the ID your file uses, chromosome, position, genotype, what it means in plain words, and whether any evidence refers to it.">
            <RawDataTable r={report} />
          </Section>
        )}
        {fl.section === "all" && (
          <>
            <Section n="◼" keyName="none" title="Coverage" intro="Every curated site and what happened to it.">
              <CoverageTable matches={report.matches.filter((m: SiteMatch) => fl.showSensitive || !m.site.sensitive)} />
            </Section>
            <Section n="◼" keyName="none" title="Sources & audit" intro="Source versions and retrieval dates, plus every claim the pipeline dropped because it could not be verified.">
              <SourcesPanel bundle={bundle} />
            </Section>
          </>
        )}
      </div>
    </>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return <div><div style={{ font: "700 2rem var(--display)" }}>{n}</div><div className="muted" style={{ fontSize: ".85rem" }}>{label}</div></div>;
}

function Section({ n, keyName, title, intro, children }: { n: string; keyName: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <section className={`block key-${keyName}`}>
      <div className="section-head"><span className="section-num">{n}</span><h2 style={{ margin: 0 }}>{title}</h2><p>{intro}</p></div>
      {children}
    </section>
  );
}

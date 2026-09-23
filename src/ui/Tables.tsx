import { useState } from "react";
import type { EvidenceBundle, Finding, Report, SiteMatch } from "../core/types";
import { Genotype } from "./Cards";
import { passes, type Filters } from "./ReportView";

export function EvidenceTable({ report, filters }: { report: Report; filters: Filters }) {
  const all: Finding[] = [...report.clinical, ...report.disease, ...report.metabolism, ...report.performance].filter((f) => passes(f, filters));
  const rows = all.flatMap((f) => {
    if (f.kind === "clinical") {
      const r = f.record;
      return [{ key: r.id, type: "ClinVar", site: f.match.site, m: f.match, allele: r.altAllele, phenotype: r.conditions.slice(0, 3).join("; "), pop: "n/a (variant classification)", effect: r.classification, strength: `${r.stars}/4 ★ ${r.reviewStatus}`, link: r.url, linkText: r.id, retrieved: r.source.retrievedAt }];
    }
    if (f.kind === "gwas") {
      return [f.lead, ...f.supporting].map((a) => ({
        key: a.id, type: a === f.lead ? "GWAS (lead)" : "GWAS", site: f.match.site, m: f.match, allele: a.effectAllele, phenotype: a.reportedTrait,
        pop: a.initialSampleSize || "—", effect: `${a.orValue != null ? `OR ${a.orValue}` : a.beta ? `β ${a.beta}` : "—"}${a.ci ? ` ${a.ci}` : ""}; p=${a.pValue}`,
        strength: a === f.lead ? f.strength : "", link: a.paperUrl, linkText: `PMID ${a.pmid}`, retrieved: a.source.retrievedAt,
      }));
    }
    return [];
  });
  return (
    <div className="table-scroll" style={{ maxHeight: 560 }}>
      <table>
        <thead><tr><th>Source</th><th>Site</th><th>Your genotype</th><th>Allele</th><th>Phenotype</th><th>Population</th><th>Effect / class</th><th>Strength</th><th>Record</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type + r.key}>
              <td>{r.type}</td><td>{r.site.label}<div className="muted mono">{r.site.rsid}</div></td><td><Genotype m={r.m} /></td>
              <td className="mono">{r.allele}</td><td>{r.phenotype}</td><td>{r.pop}</td><td>{r.effect}</td><td>{r.strength}</td>
              <td><a href={r.link} target="_blank" rel="noreferrer">{r.linkText}</a><div className="muted">retrieved {r.retrieved}</div></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={9}>No rows match the current filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function CoverageTable({ matches }: { matches: SiteMatch[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Site</th><th>rsID</th><th>Gene</th><th>Reference (forward)</th><th>Status</th><th>Your call</th><th>Position check</th><th>Notes</th></tr></thead>
        <tbody>
          {matches.map((m) => (
            <tr key={m.site.rsid}>
              <td>{m.site.label}</td><td className="mono"><a href={m.site.source.url} target="_blank" rel="noreferrer">{m.site.rsid}</a></td><td>{m.site.gene}</td>
              <td className="mono">{m.site.ref}&gt;{m.site.alts.join(",")} ({m.site.kind})</td>
              <td>{m.status.replace(/-/g, " ")}</td><td><Genotype m={m} /></td><td>{m.positionCheck}</td>
              <td className="muted">{m.notes.join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LiteraturePanel({ bundle, report, showSensitive }: { bundle: EvidenceBundle; report: Report; showSensitive: boolean }) {
  const topics = bundle.traits.filter((t) => showSensitive || t.id !== "alzheimers");
  const testedTopic = new Set(bundle.traits.filter((t) => t.rsids.some((r) => report.matches.find((m) => m.site.rsid === r)?.status === "matched")).map((t) => t.id));
  const [topic, setTopic] = useState(topics.find((t) => testedTopic.has(t.id))?.id ?? topics[0]?.id);
  const [hideAnimal, setHideAnimal] = useState(false);
  const rows = bundle.literature.filter((c) => c.topic === topic && (!hideAnimal || !c.animalOnly));
  return (
    <>
      <div className="btn-row no-print" style={{ marginBottom: 12 }}>
        <label className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>Topic
          <select value={topic} onChange={(e) => setTopic(e.target.value)} style={{ width: "auto" }}>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.label}{testedTopic.has(t.id) ? "" : " (not tested in your file)"}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={hideAnimal} onChange={(e) => setHideAnimal(e.target.checked)} /> Hide animal-only records</label>
      </div>
      <div className="table-scroll" style={{ maxHeight: 520 }}>
        <table>
          <thead><tr><th>Study</th><th>Design</th><th>Species</th><th>Genotype × intervention?</th><th>Sample size (auto)</th><th>Flags</th><th>Link</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.pmid + c.query}>
                <td><b>{c.title}</b><div className="muted">{c.journal} {c.year} · query: {c.query.split(":")[0]}</div></td>
                <td>{c.design}</td>
                <td>{c.animalOnly ? <span className="chip warn">animal only</span> : c.humans ? "human" : "unclear"}</td>
                <td>{c.mentionsGeneInteraction ? "mentions it (screened)" : "no"}</td>
                <td>{c.sampleSize ? <span title={c.sampleSize.snippet}>{c.sampleSize.value}</span> : "—"}</td>
                <td className="muted">{c.flags.join("; ")}</td>
                <td><a href={c.url} target="_blank" rel="noreferrer">PMID {c.pmid}</a>{c.doi && <div><a href={`https://doi.org/${c.doi}`} target="_blank" rel="noreferrer">DOI</a></div>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7}>No candidates for this topic.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: ".88rem" }}>
        "Genotype × intervention" is a keyword screen of the abstract. It is not a finding. Only studies verified against their abstracts appear in section 5.
        Auto-extracted sample sizes come from abstract text (hover to see the snippet) and must be checked against the paper.
      </p>
    </>
  );
}

export function SourcesPanel({ bundle }: { bundle: EvidenceBundle }) {
  const dropped = bundle.audit.filter((a) => a.outcome !== "ok");
  return (
    <div className="grid-2">
      <div>
        <h3>Source versions</h3>
        <ul>{bundle.sources.map((s) => <li key={s.source + s.version + s.url}><b>{s.source}</b>: {s.version} · retrieved {s.retrievedAt} · <a href={s.url} target="_blank" rel="noreferrer">link</a></li>)}</ul>
      </div>
      <div>
        <h3>Audit: dropped or flagged ({dropped.length})</h3>
        <ul className="limits">{dropped.map((a, i) => <li key={i}><b>{a.subject}</b> [{a.stage}, {a.outcome}]: {a.detail}</li>)}</ul>
        {!dropped.length && <p className="muted">Nothing dropped in the current build.</p>}
      </div>
    </div>
  );
}

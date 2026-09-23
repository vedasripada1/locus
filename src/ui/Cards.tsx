import { Fragment } from "react";
import type { Finding, InterventionAssessment, InterventionStudy, Quoted, SiteMatch } from "../core/types";

const pmUrl = (p: string) => `https://pubmed.ncbi.nlm.nih.gov/${p}/`;
const pval = (p: string) => { const [m, e] = p.split("e"); return <>{m}×10<sup>{e}</sup></>; };

export function Genotype({ m }: { m: SiteMatch }) {
  if (m.status === "not-on-array") return <span className="chip">not tested</span>;
  if (m.status === "no-call") return <span className="chip warn">no-call ({m.call?.raw})</span>;
  if (m.status === "allele-mismatch") return <span className="chip warn">unreadable ({m.call?.raw})</span>;
  return (
    <span className="mono">
      {m.call!.raw}
      {m.orientation === "complemented" && <> → {m.forwardAlleles.join("")} (forward strand)</>}
      {m.orientation === "ambiguous-palindromic" && <> <span className="chip warn">strand-ambiguous</span></>}
      {m.orientation === "indel-coded" && <> <span className="chip warn">indel call</span></>}
    </span>
  );
}

function Notes({ m, limits }: { m?: SiteMatch; limits: string[] }) {
  const all = [...(m?.notes ?? []), ...limits];
  if (!all.length) return null;
  return <details><summary>Limitations & matching notes ({all.length})</summary><ul className="limits">{all.map((n) => <li key={n}>{n}</li>)}</ul></details>;
}

export function FindingCard({ f, compact }: { f: Finding; compact?: boolean }) {
  if (f.kind === "clinical") {
    const r = f.record;
    const key = f.category === "pathogenic-carried" ? "clinical" : f.category === "not-tested" || f.category === "not-carried" ? "none" : "disease";
    return (
      <article className={`card key-${key}`}>
        <div className="chips">
          <span className="chip">{f.match.site.gene}</span>
          <span className={`chip ${f.category === "pathogenic-carried" || f.category === "conflicting" ? "warn" : ""}`}>{f.category.replace(/-/g, " ")}</span>
          <span className="chip">ClinVar {r.stars}/4 ★</span>
          {f.match.site.sensitive && <span className="chip">sensitive</span>}
        </div>
        <h3>{f.match.site.label} <span className="muted mono">{r.rsid}</span></h3>
        <p className="headline">{f.headline}</p>
        {!compact && (
          <dl className="facts">
            <dt>Your genotype</dt><dd><Genotype m={f.match} /></dd>
            <dt>Allele assessed</dt><dd className="mono">{r.altAllele} ({r.title})</dd>
            <dt>Classification</dt><dd>{r.classification}; {r.reviewStatus}{r.lastEvaluated ? `; last evaluated ${r.lastEvaluated}` : ""}</dd>
            <dt>Conditions</dt><dd>{r.conditions.slice(0, 6).join("; ") || "not specified"}{r.conditions.length > 6 ? ` (+${r.conditions.length - 6} more)` : ""}</dd>
            {f.clingen.length > 0 && <><dt>ClinGen validity</dt><dd>{f.clingen.map((g) => <div key={g.disease + g.moi}><a href={g.url} target="_blank" rel="noreferrer">{g.disease}</a>: {g.classification}, {g.moi}</div>)}</dd></>}
            <dt>Source</dt><dd><a href={r.url} target="_blank" rel="noreferrer">{r.id}</a>, retrieved {r.source.retrievedAt}</dd>
          </dl>
        )}
        {compact && <p className="muted" style={{ margin: 0, fontSize: ".9rem" }}>Genotype: <Genotype m={f.match} /> · <a href={r.url} target="_blank" rel="noreferrer">{r.id}</a> · {r.classification}</p>}
        <Notes m={compact ? undefined : f.match} limits={f.limitations} />
      </article>
    );
  }
  if (f.kind === "gwas") {
    const a = f.lead;
    return (
      <article className={`card key-${f.topic.domain}`}>
        <div className="chips">
          <span className={`chip ${f.strength}`}>{f.strength} evidence</span>
          <span className="chip">GWAS association</span>
          <span className="chip">{f.match.site.gene}</span>
        </div>
        <h3>{f.topic.label}: {f.match.site.label} <span className="muted mono">{a.rsid}</span></h3>
        <p className="headline">{f.headline}</p>
        <dl className="facts">
          <dt>Your genotype</dt><dd><Genotype m={f.match} /></dd>
          <dt>Effect allele</dt><dd className="mono">{a.effectAllele}{f.effectAlleleForward && f.effectAlleleForward !== a.effectAllele ? ` (forward ${f.effectAlleleForward})` : ""} · copies: {f.effectCopies ?? "not counted"}</dd>
          <dt>Phenotype</dt><dd>{a.reportedTrait}</dd>
          <dt>Effect estimate</dt><dd>{a.orValue != null ? `OR ${a.orValue} per copy` : a.beta ? `β ${a.beta} per copy` : "not reported"}{a.ci ? ` · 95% CI ${a.ci}` : ""} · p = {pval(a.pValue)}</dd>
          <dt>Study population</dt><dd>{a.initialSampleSize || "not retrieved"}</dd>
          <dt>Replication</dt><dd>{f.consistency.studies} publication(s) with concordant direction; {f.consistency.discordant} discordant association(s); {f.supporting.length + 1} genome-wide significant association(s) in the catalog</dd>
          <dt>Source</dt><dd>{a.firstAuthor} · <a href={a.url} target="_blank" rel="noreferrer">{a.studyAccession}</a> · <a href={a.paperUrl} target="_blank" rel="noreferrer">PMID {a.pmid}</a> · GWAS Catalog, retrieved {a.source.retrievedAt}</dd>
        </dl>
        <Notes m={f.match} limits={f.limitations} />
      </article>
    );
  }
  if (f.kind === "composite") {
    return (
      <article className="card key-disease">
        <div className="chips"><span className="chip">composite</span><span className="chip">sensitive</span></div>
        <h3>APOE type: {f.result}</h3>
        <p className="headline">{f.headline}</p>
        {f.ambiguity && <p className="notice alert">{f.ambiguity}</p>}
        <dl className="facts">{f.matches.map((m) => <Fragment key={m.site.rsid}><dt>{m.site.rsid}</dt><dd><Genotype m={m} /></dd></Fragment>)}</dl>
        <Notes limits={f.limitations} />
      </article>
    );
  }
  return (
    <article className="card key-none">
      <div className="chips"><span className="chip">no qualifying evidence</span></div>
      <h3>{f.topic.label}</h3>
      <p className="headline">{f.headline}</p>
      <p className="muted" style={{ margin: 0 }}>{f.topic.description}</p>
      <p className="muted" style={{ fontSize: ".9rem" }}>Sites: {f.matches.map((m) => <span key={m.site.rsid} style={{ marginRight: 12 }}>{m.site.label} <Genotype m={m} /></span>)}</p>
      <Notes limits={f.limitations} />
    </article>
  );
}

function Q({ label, q }: { label: string; q: Quoted | null }) {
  if (!q) return null;
  return <><dt>{label}</dt><dd>{q.value}<blockquote className="q">"{q.quote}"</blockquote></dd></>;
}

function StudyRow({ s }: { s: InterventionStudy }) {
  const link = s.ref.pmid ? pmUrl(s.ref.pmid) : s.source.url;
  return (
    <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 10, marginTop: 10 }}>
      <div className="chips">
        <span className="chip">{s.design}</span>
        <span className={`chip ${s.humans ? "ok" : "warn"}`}>{s.humans ? "human" : "not confirmed human"}</span>
        <span className={`chip ${s.genotypeInteraction === "tested-difference" ? "moderate" : ""}`}>
          {s.genotypeInteraction === "not-tested" ? "genotype effect not tested" : s.genotypeInteraction === "tested-no-difference" ? "tested: no difference by genotype" : "tested: difference by genotype reported"}
        </span>
      </div>
      <b>{s.title}</b>
      <div className="muted" style={{ fontSize: ".88rem" }}>
        {s.citation} · <a href={link} target="_blank" rel="noreferrer">{s.ref.pmid ? `PMID ${s.ref.pmid}` : "source"}</a>
        {s.doi && <> · <a href={`https://doi.org/${s.doi}`} target="_blank" rel="noreferrer">doi:{s.doi}</a></>}
      </div>
      <dl className="facts">
        <Q label="Sample size" q={s.sampleSize} /><Q label="Population" q={s.population} /><Q label="Dose / exposure" q={s.exposure} />
        {s.outcomes.map((o) => <Q key={o.quote} label="Outcome" q={o} />)}
        <Q label="Harms" q={s.harms} />
      </dl>
    </div>
  );
}

export function InterventionCard({ a }: { a: InterventionAssessment }) {
  const iv = a.intervention;
  const gs = { "difference-reported": "a difference by genotype has been reported (see caveats)", "tested-no-difference": "tested: the effect did not differ by genotype", "not-established": "not established: evidence is general, not genotype-specific" }[a.genotypeSpecific];
  return (
    <article className="card key-action">
      <div className="chips">
        <span className="chip">{iv.type}</span>
        <span className={`chip ${a.generalSupport}`}>best evidence: {a.bestDesign}</span>
        <span className={`chip ${a.genotypeSpecific === "difference-reported" ? "moderate" : ""}`}>genotype-specific: {a.genotypeSpecific.replace(/-/g, " ")}</span>
      </div>
      <h3>{iv.name}</h3>
      <p className="headline">{iv.summary}</p>
      <p className="muted" style={{ fontSize: ".92rem" }}><b>Why this is shown:</b> {a.triggeredBy.join("; ")}. {iv.triggerNote}</p>
      <p style={{ fontSize: ".92rem" }}><b>Does it depend on your genotype?</b> {gs}.</p>
      {a.contextWarnings.map((w) => <div key={w} className="notice alert" style={{ marginBottom: 8 }}><b>From your context:</b> {w}</div>)}
      {iv.safety && (
        <dl className="facts">
          {iv.safety.upperLimit && <><dt>Upper limit</dt><dd>{iv.safety.upperLimit.value} ({iv.safety.upperLimit.citation})<blockquote className="q">"{iv.safety.upperLimit.quote}"</blockquote></dd></>}
          {iv.safety.adverseEffects.map((q) => <Fragment key={q.quote}><dt>Adverse effects</dt><dd>{q.value} ({q.citation})<blockquote className="q">"{q.quote}"</blockquote></dd></Fragment>)}
          {iv.safety.interactions.map((q) => <Fragment key={q.quote}><dt>Interactions</dt><dd>{q.value} ({q.citation})<blockquote className="q">"{q.quote}"</blockquote></dd></Fragment>)}
        </dl>
      )}
      <details>
        <summary>Evidence ({iv.generalEvidence.length + iv.genotypeEvidence.length} verified source(s)) and limitations</summary>
        {iv.generalEvidence.length > 0 && <h4 style={{ marginTop: 12 }}>Does it affect the condition?</h4>}
        {iv.generalEvidence.map((s) => <StudyRow key={s.source.url} s={s} />)}
        {iv.genotypeEvidence.length > 0 && <h4 style={{ marginTop: 16 }}>Does the effect differ by genotype?</h4>}
        {iv.genotypeEvidence.map((s) => <StudyRow key={s.source.url} s={s} />)}
        <ul className="limits">{iv.limitations.map((l) => <li key={l}>{l}</li>)}<li>Discuss with a clinician before changing diet, medication or supplements. This report never replaces treatment.</li></ul>
      </details>
    </article>
  );
}

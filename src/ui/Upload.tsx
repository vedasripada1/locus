import { useState } from "react";
import type { EvidenceBundle } from "../core/types";
import demo23 from "../demo/synthetic-23andme.txt?raw";
import demoAnc from "../demo/synthetic-ancestrydna.txt?raw";
import { DISCLAIMER } from "../core/export";

interface Props {
  busy: string | null;
  error?: string;
  onFile: (f: File) => void;
  onDemo: (name: string, text: string) => void;
  bundle: EvidenceBundle;
}

export function Upload({ busy, error, onFile, onDemo, bundle }: Props) {
  const [over, setOver] = useState(false);
  const counts = {
    sites: bundle.sites.length,
    clinvar: bundle.clinvar.length,
    gwas: bundle.gwas.length,
    interventions: bundle.interventions.length,
  };
  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <h2>Read your raw DNA file against verified evidence</h2>
          <p>
            Upload the raw data download from <b>23andMe</b> or <b>AncestryDNA</b> (.txt, or the .zip it came in).
            The file is parsed in this browser tab. It is never uploaded, never stored, and never sent to an AI model.
          </p>
          <label
            className={`drop ${over ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
            style={{ display: "block", cursor: "pointer" }}
          >
            <input type="file" accept=".txt,.zip,.csv,.tsv,text/plain,application/zip" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            <h3 style={{ marginBottom: 6 }}>{busy ? `Reading ${busy}…` : "Drop your raw data file here"}</h3>
            <span className="btn" role="button" aria-disabled={!!busy}>{busy ? "Working" : "Choose file"}</span>
          </label>
          {error && (
            <div className="notice error" role="alert" style={{ marginTop: 16 }}>
              <b>We couldn't use that file.</b> {error}
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <span className="muted">No file handy? Try synthetic data:</span>
            <button className="btn secondary small" onClick={() => onDemo("synthetic-23andme.txt", demo23)} disabled={!!busy}>Demo 23andMe</button>
            <button className="btn secondary small" onClick={() => onDemo("synthetic-ancestrydna.txt", demoAnc)} disabled={!!busy}>Demo AncestryDNA</button>
          </div>
        </div>
        <div className="panel">
          <h3>How this works</h3>
          <ol className="steps">
            <li><span><b>Parse locally.</b> Format, genome build and call quality are checked; only the {counts.sites} curated sites are kept in memory.</span></li>
            <li><span><b>Match.</b> Alleles are aligned to the forward strand. Strand-ambiguous, missing and unreadable calls are flagged, never guessed.</span></li>
            <li><span><b>Interpret.</b> {counts.clinvar} ClinVar records and {counts.gwas} GWAS Catalog associations, kept in separate sections.</span></li>
            <li><span><b>Discuss.</b> {counts.interventions} quote-verified actions, each labelled for whether the evidence is genotype-specific.</span></li>
          </ol>
        </div>
      </div>
      <div className="notice alert">
        <b>Before you start</b>
        <ul>{DISCLAIMER.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
    </div>
  );
}

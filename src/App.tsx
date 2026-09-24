import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import bundleJson from "./evidence/bundle.json";
import type { EvidenceBundle, ParsedGenome, UserContext } from "./core/types";
import type { BulkResult } from "./core/bulk";
import type { AuditSummary } from "./core/audit";
import type { References } from "./core/refs";

export type AuditInfo = AuditSummary & { linkedByPosition: number };
import { buildReport, EMPTY_CONTEXT } from "./core/interpret";
import { Upload } from "./ui/Upload";
import { loadDemo } from "./demo";
import { ReportView } from "./ui/Shell";

const bundle = bundleJson as unknown as EvidenceBundle;
const KEEP = [...new Set(bundle.sites.flatMap((s) => [s.rsid, ...s.aliases]))];
const DATA_BASE = new URL(`${import.meta.env.BASE_URL}data/`, location.href).href;

type State =
  | { phase: "upload"; error?: string }
  | { phase: "parsing"; name: string; progress?: string }
  | { phase: "report"; name: string; genome: ParsedGenome; bulk: BulkResult | null; bulkError: string | null; audit: AuditInfo | null; refs: References | null; curatedFreq: Record<string, [string, number, string]> };

export default function App() {
  const [state, setState] = useState<State>({ phase: "upload" });
  const [context, setContext] = useState<UserContext>(EMPTY_CONTEXT);
  const workerRef = useRef<Worker | null>(null);

  const stopWorker = () => { workerRef.current?.terminate(); workerRef.current = null; };
  useEffect(() => stopWorker, []);

  const analyse = useCallback((name: string, input: { file?: File; text?: string }) => {
    stopWorker();
    setState({ phase: "parsing", name });
    const w = new Worker(new URL("./worker/parse.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e) => {
      if (e.data.progress) return setState({ phase: "parsing", name, progress: e.data.progress });
      stopWorker();
      if (e.data.ok) setState({ phase: "report", name, genome: e.data.genome, bulk: e.data.bulk, bulkError: e.data.bulkError, audit: e.data.audit, refs: e.data.refs, curatedFreq: e.data.curatedFreq ?? {} });
      else setState({ phase: "upload", error: e.data.error });
    };
    w.onerror = (e) => { stopWorker(); setState({ phase: "upload", error: `Could not read the file: ${e.message}` }); };
    w.postMessage({ ...input, keep: KEEP, exclude: KEEP, clingen: bundle.clingen, sites: bundle.sites, dataBase: DATA_BASE });
  }, []);

  // #demo=23andme or #demo=ancestrydna loads a synthetic file (for demos and smoke tests).
  useEffect(() => {
    const d = new URLSearchParams(location.hash.slice(1)).get("demo");
    if (d === "23andme" || d === "ancestrydna") loadDemo(d).then((text) => analyse(`synthetic-${d}.txt`, { text }));
  }, [analyse]);

  /** Deletion: drop every reference to genotype data and personal context. */
  const deleteAll = useCallback(() => {
    stopWorker();
    setContext(EMPTY_CONTEXT);
    setState({ phase: "upload" });
  }, []);

  const report = useMemo(
    () => (state.phase === "report" ? { ...buildReport(state.genome, bundle, context), bulk: state.bulk, bulkError: state.bulkError, audit: state.audit, table: state.genome.table, refs: state.refs, alleleFreq: state.curatedFreq } : null),
    [state, context],
  );

  return (
    <>
      <header className="masthead">
        <div className="wrap">
          <div className="brand">
            <div className="brand-mark" aria-hidden><span /></div>
            <div>
              <h1>Locus</h1>
              <p className="tagline">Evidence-linked reading of consumer raw DNA files. Every claim links to its record.</p>
            </div>
          </div>
          <div className="lock" title="Parsing and analysis run in this browser tab. The production build blocks all network connections.">
            ◼ Processed on this device only
          </div>
        </div>
      </header>
      <main>
        {state.phase !== "report" && (
          <Upload
            busy={state.phase === "parsing" ? `${state.name}${state.progress ? `: ${state.progress}` : ""}` : null}
            error={state.phase === "upload" ? state.error : undefined}
            onFile={(f) => analyse(f.name, { file: f })}
            onDemo={(name, text) => analyse(name, { text })}
            bundle={bundle}
          />
        )}
        {state.phase === "report" && report && (
          <ReportView
            report={report} bundle={bundle} fileName={state.name}
            context={context} onContext={setContext} onDelete={deleteAll}
          />
        )}
      </main>
      <footer className="footer">
        <div className="wrap">
          Evidence bundle built {bundle.builtAt.slice(0, 10)} from ClinVar, ClinGen, the NHGRI-EBI GWAS Catalog, dbSNP and PubMed.
          Not a medical device. Nothing you upload is stored or transmitted.
        </div>
      </footer>
    </>
  );
}

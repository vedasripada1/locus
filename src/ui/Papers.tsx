import { createContext, useContext, useEffect, useState } from "react";
import { loadGz } from "../core/bulk";

type Paper = [title: string, firstAuthor: string, journal: string, year: string];
export interface PapersFile { retrievedAt: string; papers: Record<string, Paper>; curatedCites: Record<string, number[]>; litvar: Record<string, number[]> }
type Study = [firstAuthor: string, year: string, journal: string, title: string];

interface Ctx {
  file: PapersFile | null; status: "idle" | "loading" | "ready" | "error"; load: () => void;
  bulkCites: Record<string, number[]>; gwasStudies: Record<string, Study>;
}
const PapersCtx = createContext<Ctx>({ file: null, status: "idle", load: () => {}, bulkCites: {}, gwasStudies: {} });
const dataUrl = (f: string) => new URL(`${import.meta.env.BASE_URL}data/${f}`, location.href).href;

/** Lazily loads the paper index (titles for ~130k PMIDs) the first time a list is opened. */
export function PapersProvider({ children, bulkCites, gwasStudies }: { children: React.ReactNode; bulkCites: Ctx["bulkCites"]; gwasStudies: Ctx["gwasStudies"] }) {
  const [file, setFile] = useState<PapersFile | null>(null);
  const [status, setStatus] = useState<Ctx["status"]>("idle");
  const load = () => {
    if (status !== "idle") return;
    setStatus("loading");
    loadGz<PapersFile>(dataUrl("papers.json.gz")).then((f) => { setFile(f); setStatus("ready"); }).catch(() => setStatus("error"));
  };
  return <PapersCtx.Provider value={{ file, status, load, bulkCites, gwasStudies }}>{children}</PapersCtx.Provider>;
}

export const usePapers = () => useContext(PapersCtx);

export interface PaperGroup { label: string; note: string; pmids: number[] }

function Row({ pmid }: { pmid: number }) {
  const { file, gwasStudies } = usePapers();
  const p = file?.papers[pmid];
  const s = gwasStudies[pmid];
  const title = p?.[0] ?? s?.[3];
  const meta = p ? `${p[1]} · ${p[2]} ${p[3]}` : s ? `${s[0]} · ${s[2]} ${s[1]}` : "";
  return (
    <li>
      {title ? <span>{title}</span> : <span className="muted">Title not in the local index</span>}
      <div className="muted" style={{ fontSize: ".85rem" }}>{meta}{meta && " · "}<a href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`} target="_blank" rel="noreferrer">PMID {pmid}</a></div>
    </li>
  );
}

/**
 * Papers that reference this specific allele, grouped by why they are listed.
 * `groups` receives the paper index (null until loaded), because curated-site citation
 * lists live in that file; counts are shown only once they are known.
 */
export function PapersList({ groups, label = "Papers for this allele" }: { groups: (f: PapersFile | null) => PaperGroup[]; label?: string }) {
  const { file, status, load } = usePapers();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<Record<string, boolean>>({});
  const nonEmpty = groups(file).filter((g) => g.pmids.length);
  const total = new Set(nonEmpty.flatMap((g) => g.pmids)).size;
  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{label}{status === "ready" || total ? ` (${total})` : ""}</summary>
      {status === "loading" && <p className="muted">Loading the local paper index…</p>}
      {status === "error" && <p className="muted">The paper index could not be loaded; PMIDs are shown without titles.</p>}
      {status === "ready" && !total && <p className="muted">No papers are linked to this allele in ClinVar, the GWAS Catalog or LitVar.</p>}
      {nonEmpty.map((g) => (
        <div key={g.label} style={{ marginTop: 10 }}>
          <b>{g.label}</b> <span className="muted">({g.pmids.length})</span>
          <div className="muted" style={{ fontSize: ".85rem" }}>{g.note}</div>
          <ul className="papers">{(all[g.label] ? g.pmids : g.pmids.slice(0, 8)).map((p) => <Row key={p} pmid={p} />)}</ul>
          {g.pmids.length > 8 && !all[g.label] && <button className="btn secondary small" onClick={() => setAll({ ...all, [g.label]: true })}>Show all {g.pmids.length}</button>}
        </div>
      ))}
    </details>
  );
}

export const LABELS = {
  clinvar: { label: "Cited in ClinVar for this variant", note: "Papers that ClinVar submitters cited as evidence for this exact allele (ClinVar var_citations)." },
  gwas: { label: "GWAS studies reporting this allele", note: "Publications behind the genome-wide significant associations shown above (GWAS Catalog)." },
  litvar: { label: "Other papers mentioning this variant", note: "Text-mined by NCBI LitVar2 for the rsID. Mentions are not endorsements, and some may concern other alleles at this site." },
};

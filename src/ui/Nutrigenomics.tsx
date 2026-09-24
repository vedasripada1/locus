import { useEffect, useMemo, useState } from "react";
import type { Report } from "../core/types";
import { loadGz } from "../core/bulk";
import { PapersList } from "./Papers";
import { plainTrait } from "../core/plain";
import { firstSentences } from "../core/refs";

/** [nutrientIdx, gene, upPmidCount, downPmidCount, pmids] */
type Row = [number, string, number, number, number[]];
interface File { version: string; retrievedAt: string; nutrients: [id: string, name: string, group: string][]; rows: Row[] }

const url = (f: string) => new URL(`${import.meta.env.BASE_URL}data/${f}`, location.href).href;

/** Genes that matter for this person, with the reason. */
export function relevantGenes(r: Report): Map<string, string> {
  const g = new Map<string, string>();
  const add = (gene: string | undefined, why: string) => { for (const x of (gene ?? "").split(/[,;\s]+/)) if (x && /^[A-Z0-9-]{2,15}$/.test(x) && !g.has(x)) g.set(x, why); };
  for (const f of r.clinical) if (f.category === "pathogenic-carried") add(f.match.site.gene, `Health finding: ${f.record.conditions[0] ?? "see Health findings"}`);
  for (const f of r.bulk?.clinvar.carried ?? []) if (f.record.stars >= 2) add(f.match.site.gene, `Health finding (chip call unverified): ${f.record.conditions[0] ?? "see Health findings"}`);
  for (const f of [...r.disease, ...r.metabolism, ...r.performance]) if (f.kind === "gwas" && (f.effectCopies ?? 0) > 0 && f.strength !== "conflicting") add(f.match.site.gene, `You carry a variant here linked to ${f.topic.phrase}: ${f.topic.description}`);
  for (const h of r.bulk?.gwas.hits ?? []) {
    if (h.strength !== "strong" || !(h.copies ?? 0)) continue;
    const what = h.traitDefinition ? `: ${firstSentences(h.traitDefinition, 1)}` : "";
    add(h.gene, `You carry a well-replicated variant here linked to ${plainTrait(h.trait, h.kind)}${what}`);
  }
  return g;
}

export function NutrientGenes({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState(false);
  const [group, setGroup] = useState("all");
  const [gene, setGene] = useState("all");
  const [replicated, setReplicated] = useState(true);
  const genes = useMemo(() => relevantGenes(report), [report]);
  useEffect(() => { if (open && !file) loadGz<File>(url("nutrigenomics.json.gz")).then(setFile).catch(() => setError(true)); }, [open, file]);

  const rows = useMemo(() => {
    if (!file) return [];
    return file.rows
      .filter((r) => genes.has(r[1]) && (gene === "all" || r[1] === gene) && (group === "all" || file.nutrients[r[0]][2] === group))
      .filter((r) => !replicated || ((r[2] >= 2 && r[3] === 0) || (r[3] >= 2 && r[2] === 0)))
      .sort((a, b) => (b[2] + b[3]) - (a[2] + a[3]));
  }, [file, genes, gene, group, replicated]);
  const genesWithData = useMemo(() => (file ? [...new Set(file.rows.filter((r) => genes.has(r[1])).map((r) => r[1]))].sort() : []), [file, genes]);

  return (
    <section className="block">
      <details className="panel" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Nutrients and your genes: lab research ({genes.size} of your relevant genes)</summary>
        <div className="notice alert" style={{ margin: "12px 0" }}>
          <b>Research, not recommendations.</b> These are human lab studies (mostly cells) in which a nutrient or food compound raised or lowered how much a gene is expressed.
          A change in gene expression in a lab does not show a health benefit. Doses in these studies are often far above what food provides.
          None of these studies tested people with your genotype. That's why none of this appears under Diet &amp; supplements.
        </div>
        <p className="muted" style={{ fontSize: ".9rem" }}>
          Genes included: those linked to health findings or well-replicated traits where you carry the reported allele. Many trait variants sit near a gene rather than inside it, so the gene shown is the catalog's mapped gene.
          Data: <a href="https://ctdbase.org/" target="_blank" rel="noreferrer">Comparative Toxicogenomics Database (CTD)</a>, curated chemical–gene interactions, human only{file ? `, release ${file.version}` : ""}.
        </p>
        {error && <p className="muted">The nutrient–gene data could not be loaded.</p>}
        {file && (
          <>
            <div className="btn-row" style={{ gap: "8px 16px", marginBottom: 10 }}>
              <label>Gene <select value={gene} onChange={(e) => setGene(e.target.value)} style={{ width: "auto" }}>
                <option value="all">All relevant genes ({genesWithData.length})</option>
                {genesWithData.map((g) => <option key={g} value={g}>{g}</option>)}
              </select></label>
              <label>Nutrient type <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ width: "auto" }}>
                {["all", "Vitamins", "Minerals", "Fats", "Sugars", "Plant compounds", "Other"].map((x) => <option key={x} value={x}>{x === "all" ? "All" : x}</option>)}
              </select></label>
              <label><input type="checkbox" checked={replicated} onChange={(e) => setReplicated(e.target.checked)} /> Only consistent findings (2+ papers agree, none disagree)</label>
              <span className="muted">{rows.length} results</span>
            </div>
            <div className="table-scroll" style={{ maxHeight: 560 }}>
              <table>
                <thead><tr><th>Gene</th><th>Why it's relevant to you</th><th>Nutrient</th><th>Lab finding</th><th>Papers</th></tr></thead>
                <tbody>
                  {rows.slice(0, 300).map((r) => {
                    const [id, name, grp] = file.nutrients[r[0]];
                    const dir = r[2] && r[3] ? `mixed: raised in ${r[2]}, lowered in ${r[3]} paper(s)` : r[2] ? `raised expression (${r[2]} paper${r[2] === 1 ? "" : "s"})` : `lowered expression (${r[3]} paper${r[3] === 1 ? "" : "s"})`;
                    return (
                      <tr key={`${r[0]}-${r[1]}`}>
                        <td className="mono"><a href={`https://ctdbase.org/basicQuery.go?bqCat=gene&bq=${r[1]}`} target="_blank" rel="noreferrer">{r[1]}</a></td>
                        <td className="muted">{genes.get(r[1])}</td>
                        <td><a href={`https://ctdbase.org/detail.go?type=chem&acc=${id}`} target="_blank" rel="noreferrer">{name}</a><div className="muted" style={{ fontSize: ".8rem" }}>{grp}</div></td>
                        <td>{r[2] && !r[3] ? "↑ " : !r[2] && r[3] ? "↓ " : "↕ "}{dir}</td>
                        <td><PapersList label="Papers" groups={() => [{ label: "Lab studies (CTD)", note: "Human lab studies curated by CTD for this nutrient and gene.", pmids: r[4] }]} /></td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={5}>No {replicated ? "consistent " : ""}findings for these filters.</td></tr>}
                </tbody>
              </table>
            </div>
            {rows.length > 300 && <p className="muted">Showing the 300 best-studied of {rows.length}. Narrow by gene or nutrient type.</p>}
          </>
        )}
      </details>
    </section>
  );
}

import { siteLine } from "./genes";
// Stage 4 — narrative / export. Renders a Report with fixed templates only.
// No generated prose: every sentence is either a template or a verified value.
import type { EvidenceBundle, Finding, Report } from "./types";
import type { Summary } from "./plain";

export const DISCLAIMER = [
  "This report is for information and discussion only. It is not a diagnosis and cannot rule a diagnosis in or out.",
  "Consumer raw data can contain genotyping errors, especially for rare variants. Any potentially serious finding must be confirmed by clinical-grade testing and discussed with a genetics professional.",
  "Do not stop or change medication, replace treatment, or take high-dose supplements based on this report.",
  "Variants not in your file were not tested. A missing variant is never treated as a negative result.",
];

const gt = (f: Finding) => {
  const m = f.kind === "gwas" || f.kind === "clinical" ? f.match : f.matches[0];
  return m?.call ? `${m.call.raw}${m.orientation === "complemented" ? ` (forward ${m.forwardAlleles.join("")})` : ""}` : m?.status ?? "-";
};

function findingMd(f: Finding): string {
  if (f.kind === "clinical") {
    const r = f.record;
    return `### ${f.match.site.label} (${r.rsid})\n- **Your genotype:** ${gt(f)}\n- **ClinVar allele:** ${r.altAllele}; **classification:** ${r.classification} (${r.reviewStatus}, ${r.stars}/4 stars)\n- **Conditions:** ${r.conditions.join("; ") || "not specified"}\n- **Finding:** ${f.headline}\n- **Source:** [${r.id}](${r.url}), retrieved ${r.source.retrievedAt}${f.clingen.length ? `\n- **ClinGen:** ${f.clingen.map((g) => `${g.disease} (${g.moi}, ${g.classification})`).join("; ")}` : ""}\n- **Limitations:** ${f.limitations.join(" ")}\n`;
  }
  if (f.kind === "gwas") {
    const a = f.lead;
    return `### ${f.topic.label}: ${f.match.site.label} (${a.rsid})\n- **Your genotype:** ${gt(f)}\n- **Effect allele:** ${a.effectAllele}${f.effectAlleleForward && f.effectAlleleForward !== a.effectAllele ? ` (forward ${f.effectAlleleForward})` : ""}; copies: ${f.effectCopies ?? "not counted"}\n- **Finding:** ${f.headline}\n- **Lead study:** ${a.firstAuthor}, [${a.studyAccession}](${a.url}), [PMID ${a.pmid}](${a.paperUrl}); p = ${a.pValue.replace("e", "×10^")}; ${a.orValue != null ? `OR ${a.orValue}` : a.beta ? `β ${a.beta}` : "no effect size"}${a.ci ? ` ${a.ci}` : ""}\n- **Population:** ${a.initialSampleSize || "not retrieved"}\n- **Evidence strength:** ${f.strength} (${f.consistency.studies} publication(s) concordant, ${f.consistency.discordant} discordant association(s))\n- **Limitations:** ${f.limitations.join(" ")}\n`;
  }
  if (f.kind === "composite") return `### ${f.topic.label}: APOE\n- **Result:** ${f.result}${f.ambiguity ? ` (${f.ambiguity})` : ""}\n- ${f.headline}\n- **Limitations:** ${f.limitations.join(" ")}\n`;
  return `### ${f.topic.label}\n- ${f.headline}\n`;
}

/** Plain-language summary: what it means, what to do, and why. */
export function summaryMd(s: Summary): string {
  const groups: [string, string][] = [["quality", "Check your file"], ["confirm", "Confirm with a doctor"], ["action", "Things you could do"], ["know", "Good to know"], ["clear", "Checked and not found"]];
  return [`# Summary\n\n**${s.headline}**`, ...groups.map(([tone, title]) => {
    const items = s.items.filter((i) => i.tone === tone);
    if (!items.length) return "";
    return `## ${title}\n\n${items.map((i) => [
      `### ${i.title}`, i.plain, ...(i.list ?? []).map((l) => `- ${l}`),
      `**What you could do:**`, ...i.next.map((n) => `- ${n}`),
      `**Why you're seeing this** (${i.confidence} confidence):`, ...i.why.filter(Boolean).map((w) => `- ${w}`),
      ...(i.sources.length ? [`Sources: ${i.sources.map((x) => `[${x.label}](${x.url})`).join(", ")}`] : []),
    ].join("\n")).join("\n\n")}`;
  })].filter(Boolean).join("\n\n");
}

export function toMarkdown(r: Report, bundle: EvidenceBundle, opts: { showSensitive: boolean }, summary?: Summary): string {
  const hide = (f: Finding) => !opts.showSensitive && (f.kind === "gwas" || f.kind === "clinical" ? f.match.site.sensitive : f.kind === "composite" || f.topic.id === "alzheimers");
  const sec = (title: string, fs: Finding[]) => `## ${title}\n\n${fs.filter((f) => !hide(f)).map(findingMd).join("\n") || "_Nothing to show._\n"}`;
  const out = [
    ...(summary ? [summaryMd(summary), "---\n\n# Appendix: technical report"] : []),
    `# Genotype evidence report`,
    `Generated ${r.generatedAt.slice(0, 10)} from a ${r.file.format === "23andme" ? "23andMe" : "AncestryDNA"} file (${r.file.build}). Evidence bundle built ${bundle.builtAt.slice(0, 10)}.`,
    `> ${DISCLAIMER.join("\n> ")}`,
    `## File and coverage\n- Rows: ${r.file.stats.totalRows.toLocaleString()}, call rate ${(r.file.stats.callRate * 100).toFixed(2)}%\n- Curated sites: ${r.coverage.total}; tested ${r.coverage.matched}; not on array ${r.coverage.notOnArray}; no-call ${r.coverage.noCall}; allele mismatch ${r.coverage.mismatch}\n${r.file.issues.map((i) => `- ${i.severity.toUpperCase()}: ${i.message}`).join("\n")}`,
    sec("1. Clinically significant findings requiring confirmation", r.clinical.filter((f) => f.category === "pathogenic-carried")),
    sec("Other clinical-variant results (ClinVar)", r.clinical.filter((f) => f.category !== "pathogenic-carried")),
    sec("2. Common disease associations (GWAS)", r.disease),
    sec("3. Metabolism", r.metabolism),
    sec("4. Performance", r.performance),
    `## 5. Possible actions to discuss\n\n${r.interventions.filter((a) => opts.showSensitive || !a.triggeredBy.some((t) => /alzheimer/i.test(t))).map((a) => {
      const iv = a.intervention;
      const studies = [...iv.generalEvidence, ...iv.genotypeEvidence];
      return `### ${iv.name}\n- **Type:** ${iv.type}; **why shown:** ${a.triggeredBy.join("; ")}\n- ${iv.triggerNote}\n- **Summary:** ${iv.summary}\n- **Best evidence that it helps at all:** ${a.bestDesign}; **genotype-specific evidence:** ${a.genotypeSpecific.replace(/-/g, " ")}\n${studies.map((s) => `- ${s.citation}, ${s.design}${s.sampleSize ? `, n=${s.sampleSize.value}` : ""}${s.ref.pmid ? `, PMID ${s.ref.pmid}` : ""}${s.doi ? `, doi:${s.doi}` : ""}: genotype interaction ${s.genotypeInteraction}`).join("\n")}${iv.safety?.upperLimit ? `\n- **Upper limit:** ${iv.safety.upperLimit.value} (${iv.safety.upperLimit.citation})` : ""}${a.contextWarnings.map((w) => `\n- **Note:** ${w}`).join("")}\n- **Limitations:** ${iv.limitations.join(" ")}\n`;
    }).join("\n") || "_No evidence-based personalized action._\n"}${(() => { const t = r.topicsWithoutAction.filter((x) => opts.showSensitive || !/alzheimer/i.test(x)); return t.length ? `\n**No evidence-based personalized action for:** ${t.join(", ")}.\n` : ""; })()}`,
    ...(r.genes?.length ? [genesMd(r, opts)] : []),
    ...(r.bulk ? [bulkMd(r, opts)] : []),
    `## Sources\n${r.evidenceSources.map((s) => `- ${s.source}: ${s.version} (retrieved ${s.retrievedAt}) ${s.url}`).join("\n")}`,
  ];
  return out.join("\n\n");
}

const VERDICT_MD: Record<string, string> = {
  "changes-advice": "Your DNA can change the advice", limited: "Some genotype-specific evidence", "test-instead": "A blood test answers this better",
  "same-advice": "Same advice whatever your DNA", "no-proven-action": "Affects a level; no proven action", trait: "Just a trait",
};

/** Gene guide: reading, verdict and verified quotes per gene. */
export function genesMd(r: Report, opts: { showSensitive: boolean }): string {
  const rows = (r.genes ?? []).filter((g) => opts.showSensitive || !g.entry.sensitive).map((g) => {
    const e = g.entry;
    return [`### ${e.title} (${e.gene})`,
      `- **Your DNA:** ${g.sites.map((s, i) => siteLine(s, e.sites[i].alleleName, e.sites[i].allele)).join("; ")}`,
      `- **Reading:** ${g.status === "not-tested" ? "Not on your chip (not tested)." : g.reading?.text ?? "Only partly readable."}`,
      `- **Does your DNA change what to do?** ${VERDICT_MD[e.verdict]}. ${e.verdictNote}`,
      ...e.evidence.map((q) => `- ${q.value}: "${q.quote}" (${q.citation}${q.source.url ? `, ${q.source.url}` : ""})`),
      ...(e.caveat ? [`- **Limits:** ${e.caveat}`] : []),
    ].join("\n");
  });
  return `## 6. Traits and genes\n\nEach reading is fixed text checked against its sources; alleles are on the forward strand.\n\n${rows.join("\n\n")}`;
}

/** JSON export omits nothing about findings but never includes the raw file. */
export function toJson(r: Report): string {
  // Never export the raw genotype table or the list of file row IDs.
  return JSON.stringify(r, (k, v) => (v instanceof Map || k === "table" || k === "fileIds" ? undefined : v), 2);
}

function bulkMd(r: Report, opts: { showSensitive: boolean }): string {
  const b = r.bulk!;
  const cv = b.clinvar.carried.map((f) => {
    const id = f.record.url.match(/variation\/(\d+)/)?.[1] ?? "";
    const pm = b.clinvar.cites[id] ?? [];
    return `- **${f.record.title}** (${f.record.rsid}), genotype ${f.match.call?.raw}: ${f.record.classification}, ${f.record.stars}/4★. ${f.record.conditions.slice(0, 3).join("; ")}. [ClinVar](${f.record.url})${pm.length ? `. ClinVar-cited PMIDs: ${pm.slice(0, 10).join(", ")}${pm.length > 10 ? ` (+${pm.length - 10})` : ""}` : ""}`;
  });
  const gw = b.gwas.hits
    .filter((h) => (h.copies ?? 0) > 0 && (h.strength === "strong" || h.strength === "moderate"))
    .filter((h) => opts.showSensitive || !/alzheimer/i.test(h.trait))
    .sort((a, c) => c.concordantPubs - a.concordantPubs);
  return [
    `## Genome-wide ClinVar screen (ClinVar ${b.clinvar.version})`,
    `${b.clinvar.tested.toLocaleString()} ClinVar pathogenic/likely pathogenic sites were readable in the file; the listed allele was observed at ${b.clinvar.carried.length}. Consumer chips are unreliable for very rare variants: every entry below needs clinical confirmation.`,
    cv.join("\n") || "_None observed._",
    `## GWAS Catalog explorer (${b.gwas.version})`,
    `${b.gwas.hits.length.toLocaleString()} genome-wide significant associations involve ${b.gwas.tested.toLocaleString()} readable sites. Listed: ${gw.length} where you carry the reported allele and at least two publications agree. Use the app's CSV export for all rows.`,
    gw.map((h) => `- ${h.trait}: ${h.gene || "?"} ${h.rsid} ${h.genotype}, ${h.effectAllele}×${h.copies}, ${h.kind} ${h.value}, p=${h.p}, ${h.strength} (${h.concordantPubs} papers). PMIDs: ${h.pmids.slice(0, 6).join(", ")}`).join("\n") || "_None._",
  ].join("\n\n");
}

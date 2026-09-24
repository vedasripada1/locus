// Plain-language reference text for the report, from two NIH sources, stored verbatim:
//  - GeneReviews (NCBI Bookshelf): per gene, the chapter's structured abstract sections
//    (clinical characteristics, management, genetic counseling). Used for health findings.
//  - MedlinePlus (NLM): health-topic summaries for trait families, plus the summary's sentences
//    about diet, activity and lifestyle. Used for trait panels. General advice, not genotype-specific.
// Output: pipeline/out/references.json (packaged to public/data/references.json.gz).
import { get, writeJson } from "../lib/http";
import { fetchRecords, stripTags } from "../lib/pubmed";

/** Trait families (EFO label patterns) → MedlinePlus health topics, by exact topic title ("Title@search terms" when the title itself searches poorly). */
export const TRAIT_TOPICS: { id: string; pattern: string; topics: string[] }[] = [
  { id: "red-cells", pattern: "hemoglobin|erythrocyte|red blood cell|red cell|hematocrit|corpuscular|reticulocyte", topics: ["Anemia"] },
  { id: "iron", pattern: "ferritin|serum iron|transferrin|iron biomarker", topics: ["Iron", "Hemochromatosis"] },
  { id: "vitamin-d", pattern: "vitamin d", topics: ["Vitamin D"] },
  { id: "b12", pattern: "vitamin b12|cobalamin", topics: ["B Vitamins@vitamin b12"] },
  { id: "folate", pattern: "folate|folic acid", topics: ["Folic Acid"] },
  { id: "calcium", pattern: "calcium measurement", topics: ["Calcium"] },
  { id: "ldl", pattern: "low density lipoprotein|total cholesterol|apolipoprotein b", topics: ["Cholesterol", "LDL: The \"Bad\" Cholesterol@ldl cholesterol"] },
  { id: "hdl", pattern: "high density lipoprotein|apolipoprotein a", topics: ["HDL: The \"Good\" Cholesterol@hdl cholesterol"] },
  { id: "tg", pattern: "triglyceride", topics: ["Triglycerides"] },
  { id: "glucose", pattern: "glucose measurement|hba1c|glycated hemoglobin|insulin", topics: ["Blood Glucose@blood sugar", "Prediabetes"] },
  { id: "t2d", pattern: "type 2 diabetes", topics: ["Diabetes Type 2"] },
  { id: "weight", pattern: "body mass index|obesity|waist|hip circumference|body fat|body weight|adiposity", topics: ["Obesity", "Weight Control"] },
  { id: "bp", pattern: "blood pressure|hypertension", topics: ["High Blood Pressure"] },
  { id: "cad", pattern: "coronary artery disease|myocardial infarction", topics: ["Coronary Artery Disease"] },
  { id: "afib", pattern: "atrial fibrillation", topics: ["Atrial Fibrillation"] },
  { id: "stroke", pattern: "stroke", topics: ["Stroke"] },
  { id: "asthma", pattern: "asthma", topics: ["Asthma"] },
  { id: "ibd", pattern: "crohn|inflammatory bowel|ulcerative colitis", topics: ["Crohn's Disease@crohn", "Ulcerative Colitis"] },
  { id: "celiac", pattern: "celiac", topics: ["Celiac Disease"] },
  { id: "psoriasis", pattern: "psoriasis", topics: ["Psoriasis"] },
  { id: "ra", pattern: "rheumatoid arthritis", topics: ["Rheumatoid Arthritis"] },
  { id: "gout", pattern: "\\burate\\b|uric acid|\\bgout\\b", topics: ["Gout"] },
  { id: "kidney", pattern: "glomerular filtration|creatinine|kidney", topics: ["Chronic Kidney Disease"] },
  { id: "liver", pattern: "alanine aminotransferase|aspartate aminotransferase|gamma-glutamyl|liver fat|fatty liver", topics: ["Steatotic Liver Disease@fatty liver", "Liver Diseases@liver function"] },
  { id: "bone", pattern: "bone mineral density|osteoporosis|fracture", topics: ["Osteoporosis"] },
  { id: "sleep", pattern: "sleep|insomnia|chronotype|morning person", topics: ["Sleep Disorders", "Insomnia"] },
  { id: "caffeine", pattern: "coffee|caffeine", topics: ["Caffeine"] },
  { id: "alcohol", pattern: "alcohol", topics: ["Alcohol"] },
  { id: "fitness", pattern: "grip strength|physical activity|fitness|lean mass|walking pace|muscle", topics: ["Exercise and Physical Fitness"] },
  { id: "lactose", pattern: "lactose|lactase", topics: ["Lactose Intolerance"] },
];

const LIFESTYLE = /\b(diet|dietary|eat|eating|food|foods|nutrition|nutrient|drink|drinking|alcohol|exercise|physical activity|active|weight|lifestyle|smok|sleep|fiber|salt|sodium|sugar|supplement)/i;
const sentences = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);

export interface Topic { title: string; url: string; summary: string; lifestyle: string[] }

const HELPS = /\b(lower|reduce|prevent|help|helps|treat|treatment|manage|control|improve|may be able)\b/i;

/**
 * Diet/lifestyle passages, verbatim. A bullet list stays together with the sentence that introduces
 * it, so "• Cigarette smoking" is never shown without saying whether it raises or lowers something.
 * Passages about what helps come first.
 */
export function lifestyleBlocks(summary: string): string[] {
  const blocks: string[] = [];
  const lines = summary.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("•")) continue;
    const bullets: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith("•"); j++) bullets.push(lines[j]);
    if (bullets.length) {
      const lead = sentences(l).pop() ?? l; // the sentence right before the list
      if (LIFESTYLE.test(lead) || bullets.some((b) => LIFESTYLE.test(b))) blocks.push([lead, ...bullets].join("\n"));
    } else {
      for (const sn of sentences(l)) if (LIFESTYLE.test(sn) && HELPS.test(sn)) blocks.push(sn);
    }
  }
  return [...blocks.filter((b) => HELPS.test(b.split("\n")[0])), ...blocks.filter((b) => !HELPS.test(b.split("\n")[0]))].slice(0, 4);
}

/** HTML → text keeping list items and paragraphs on their own lines. */
function htmlText(html: string): string {
  const h = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/<\/?span[^>]*>/gi, ""); // search-hit highlighting: remove without adding spaces
  const BREAK = "¶"; // not whitespace, so stripTags' space-collapsing leaves it alone
  return stripTags(h.replace(/<li>/gi, `${BREAK}• `).replace(/<\/(p|ul|ol|h\d)>/gi, BREAK).replace(/<br\s*\/?>/gi, BREAK))
    .split(BREAK).map((x) => x.replace(/\s+([,.;:])/g, "$1").trim()).filter(Boolean).join("\n");
}

async function medlinePlus(spec: string): Promise<Topic | null> {
  const [title, query = title] = spec.split("@");
  const c = await get<string>(`https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&retmax=8&term=${encodeURIComponent(query)}`, "text");
  for (const doc of c.body.match(/<document [\s\S]*?<\/document>/g) ?? []) {
    const url = doc.match(/url="([^"]+)"/)?.[1] ?? "";
    const raw = (n: string) => doc.match(new RegExp(`<content name="${n}">([\\s\\S]*?)</content>`))?.[1] ?? "";
    const t = htmlText(raw("title")).replace(/\s+/g, " ");
    if (t.toLowerCase() !== title.toLowerCase()) continue; // only the exact topic asked for
    const summary = htmlText(raw("FullSummary"));
    return { title: t, url, summary, lifestyle: lifestyleBlocks(summary) };
  }
  return null;
}

export interface Chapter { pmid: string; nbk: string; title: string; clinical: string; management: string; counseling: string; url: string }

function section(abstract: string, label: string): string {
  const m = abstract.match(new RegExp(`(?:^|\\n)${label}: ([\\s\\S]*?)(?=\\n[A-Z/ ]+: |$)`));
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  // GeneReviews
  const titles = (await get<string>("https://ftp.ncbi.nlm.nih.gov/pub/GeneReviews/GRtitle_shortname_NBKid.txt", "text")).body;
  const genes = (await get<string>("https://ftp.ncbi.nlm.nih.gov/pub/GeneReviews/NBKid_shortname_genesymbol.txt", "text")).body;
  const byNbk = new Map<string, { title: string; pmid: string }>();
  for (const l of titles.split("\n").filter((x) => x && !x.startsWith("#"))) { const [, title, nbk, pmid] = l.split("\t"); if (pmid) byNbk.set(nbk, { title, pmid: pmid.trim() }); }
  const recs = await fetchRecords([...byNbk.values()].map((v) => v.pmid));
  const byPmid = new Map(recs.map((r) => [r.pmid, r]));
  const chapters: Chapter[] = [];
  const chapterIdx = new Map<string, number>();
  for (const [nbk, v] of byNbk) {
    const r = byPmid.get(v.pmid);
    if (!r?.abstract) continue;
    const ch: Chapter = { pmid: v.pmid, nbk, title: v.title, url: `https://www.ncbi.nlm.nih.gov/books/${nbk}/`,
      clinical: section(r.abstract, "CLINICAL CHARACTERISTICS"), management: section(r.abstract, "MANAGEMENT"), counseling: section(r.abstract, "GENETIC COUNSELING") };
    if (!ch.clinical && !ch.management) continue;
    chapterIdx.set(nbk, chapters.length);
    chapters.push(ch);
  }
  const geneMap: Record<string, number[]> = {};
  for (const l of genes.split("\n").filter((x) => x && !x.startsWith("#"))) {
    const [nbk, , gene] = l.split("\t").map((x) => x.trim());
    const i = chapterIdx.get(nbk);
    if (i != null && gene && gene !== "Not applicable") (geneMap[gene] ??= []).includes(i) || geneMap[gene].push(i);
  }
  console.log(`GeneReviews: ${chapters.length} chapters with structured abstracts, ${Object.keys(geneMap).length} genes`);

  // MedlinePlus
  const topics: Record<string, Topic> = {};
  for (const fam of TRAIT_TOPICS) for (const t of fam.topics) {
    const title = t.split("@")[0];
    if (topics[title]) continue;
    const got = await medlinePlus(t);
    if (got) topics[title] = got; else console.warn(`  MedlinePlus topic not found (dropped): ${title}`);
  }
  console.log(`MedlinePlus: ${Object.keys(topics).length} topics`);
  writeJson("pipeline/out/references.json", {
    retrievedAt: new Date().toISOString().slice(0, 10),
    genereviews: { chapters, genes: geneMap },
    medlineplus: { families: TRAIT_TOPICS.map((f) => ({ ...f, topics: f.topics.map((t) => t.split("@")[0]).filter((t) => topics[t]) })).filter((f) => f.topics.length), topics },
  });
}

if (process.argv[1]?.endsWith("references.ts")) main().catch((e) => { console.error(e); process.exit(1); });

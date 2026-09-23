// PubMed / PMC access via NCBI E-utilities (the documented API; no scraping).
import { XMLParser } from "fast-xml-parser";
import { get } from "./http";
import type { SourceVersion, StudyDesign } from "../../src/core/types";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", htmlEntities: true, isArray: (n) =>
  ["PubmedArticle", "PubmedBookArticle", "AbstractText", "PublicationType", "MeshHeading", "ArticleId", "Author", "ELocationID"].includes(n) });

/** Flatten a parsed XML node (with inline markup) into plain text. */
export function text(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node === "object") return Object.entries(node).filter(([k]) => !k.startsWith("@")).map(([, v]) => text(v)).join(" ");
  return "";
}

export interface PubmedRecord {
  pmid: string; title: string; abstract: string; journal: string; year: string; doi: string | null;
  firstAuthor: string; publicationTypes: string[]; mesh: string[]; book: boolean; source: SourceVersion;
}

export async function search(term: string, retmax = 8): Promise<string[]> {
  const c = await get<any>(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${retmax}&term=${encodeURIComponent(term)}`);
  return c.body.esearchresult?.idlist ?? [];
}

/** Decode XML/HTML entities, including numeric ones (&#x3bc; → μ). */
export function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Text of an XML fragment in document order; inline tags (<i>, <sub>) add no spaces. */
export function inlineText(xmlFragment: string): string {
  return decodeEntities(xmlFragment.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Title and abstract straight from the raw XML, so inline markup keeps its place. */
function rawTexts(body: string): Map<string, { title: string; abstract: string }> {
  const out = new Map<string, { title: string; abstract: string }>();
  for (const block of body.match(/<Pubmed(Book)?Article>[\s\S]*?<\/Pubmed(Book)?Article>/g) ?? []) {
    const pmid = block.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    if (!pmid) continue;
    const title = inlineText(block.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? block.match(/<BookTitle[^>]*>([\s\S]*?)<\/BookTitle>/)?.[1] ?? "");
    const parts = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attrs, inner]) => {
      const label = attrs.match(/Label="([^"]*)"/)?.[1];
      return (label ? `${decodeEntities(label)}: ` : "") + inlineText(inner);
    });
    out.set(pmid, { title, abstract: parts.join("\n") });
  }
  return out;
}

export async function fetchRecords(pmids: string[]): Promise<PubmedRecord[]> {
  const out: PubmedRecord[] = [];
  for (let i = 0; i < pmids.length; i += 50) {
    const batch = pmids.slice(i, i + 50);
    const c = await get<string>(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&id=${batch.join(",")}`, "text");
    const doc = xml.parse(c.body).PubmedArticleSet ?? {};
    const raw = rawTexts(c.body);
    for (const a of doc.PubmedArticle ?? []) {
      const m = a.MedlineCitation, art = m.Article;
      const ids = a.PubmedData?.ArticleIdList?.ArticleId ?? [];
      const doi = ids.find((x: any) => x["@IdType"] === "doi")?.["#text"] ?? art.ELocationID?.find((x: any) => x["@EIdType"] === "doi")?.["#text"] ?? null;
      out.push(withRaw(rec(String(text(m.PMID)), text(art.ArticleTitle), art.Abstract?.AbstractText, text(art.Journal?.ISOAbbreviation ?? art.Journal?.Title),
        String(art.Journal?.JournalIssue?.PubDate?.Year ?? text(art.Journal?.JournalIssue?.PubDate?.MedlineDate).slice(0, 4)),
        doi, art.AuthorList?.Author?.[0], (art.PublicationTypeList?.PublicationType ?? []).map(text),
        (m.MeshHeadingList?.MeshHeading ?? []).map((h: any) => text(h.DescriptorName)), false, c.retrievedAt), raw));
    }
    for (const b of doc.PubmedBookArticle ?? []) {
      const d = b.BookDocument;
      out.push(withRaw(rec(String(text(d.PMID)), text(d.ArticleTitle ?? d.Book?.BookTitle), d.Abstract?.AbstractText,
        text(d.Book?.BookTitle), String(d.Book?.PubDate?.Year ?? ""), null, d.AuthorList?.Author?.[0],
        (d.PublicationType ?? []).map(text), [], true, c.retrievedAt), raw));
    }
  }
  return out;
}

function withRaw(r: PubmedRecord, raw: Map<string, { title: string; abstract: string }>): PubmedRecord {
  const t = raw.get(r.pmid);
  return t ? { ...r, title: t.title || r.title, abstract: t.abstract } : r;
}

function rec(pmid: string, title: string, abs: any, journal: string, year: string, doi: string | null, author: any,
  publicationTypes: string[], mesh: string[], book: boolean, retrievedAt: string): PubmedRecord {
  const abstract = (abs ?? []).map((p: any) => (p?.["@Label"] ? `${p["@Label"]}: ` : "") + text(p)).join("\n");
  return {
    pmid, title: title.replace(/\s+/g, " ").trim(), abstract, journal, year, doi, book,
    firstAuthor: author ? text(author.LastName ?? author.CollectiveName) : "",
    publicationTypes, mesh,
    source: { source: "PubMed", version: `PMID ${pmid}`, retrievedAt: retrievedAt.slice(0, 10), url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` },
  };
}

/** PMC full text (open-access subset via efetch). */
export async function fetchPmcText(pmcid: string): Promise<{ text: string; source: SourceVersion; title: string }> {
  const id = pmcid.replace(/^PMC/i, "");
  const c = await get<string>(`${EUTILS}/efetch.fcgi?db=pmc&id=${id}`, "text");
  const title = (c.body.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/)?.[1] ?? "").replace(/<[^>]+>/g, "");
  return { text: stripTags(c.body), title, source: { source: "PubMed", version: `PMC${id} full text`, retrievedAt: c.retrievedAt.slice(0, 10), url: `https://pmc.ncbi.nlm.nih.gov/articles/PMC${id}/` } };
}

export function stripTags(s: string) {
  return decodeEntities(s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/?(sub|sup|i|b|em|strong|italic|bold)>/gi, "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&rsquo;/g, "’").replace(/&lsquo;/g, "‘").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")).replace(/\s+/g, " ");
}

export function classifyDesign(pubTypes: string[], mesh: string[]): StudyDesign {
  const t = pubTypes.map((x) => x.toLowerCase());
  if (t.includes("meta-analysis")) return "meta-analysis";
  if (t.includes("systematic review")) return "systematic review";
  if (t.includes("randomized controlled trial")) return "randomized controlled trial";
  if (t.some((x) => x.includes("guideline"))) return "guideline";
  if (t.includes("review")) return "review";
  if (t.includes("observational study") || mesh.some((m) => /Cohort Studies|Case-Control Studies|Cross-Sectional Studies|Prospective Studies/.test(m))) return "observational";
  return "other";
}

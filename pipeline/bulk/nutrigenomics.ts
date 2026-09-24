// Nutrient–gene expression evidence from the Comparative Toxicogenomics Database (CTD).
// Keeps only: human (NCBI taxon 9606), a curated list of dietary compounds, and simple
// direct statements "<compound> results in increased|decreased expression of <GENE> mRNA|protein".
// Aggregated per (compound, gene): up/down PMID counts and the PMIDs themselves.
// This is laboratory evidence (mostly cell studies). The app shows it as research, never as advice.
//
// CTD terms (ctdbase.org/about/legal.jsp): cite CTD; link to CTD pages where the data is used;
// notify CTD and give access if the app is published. Input: pipeline/cache/bulk/ctd_chem_gene_ixns.tsv.gz
import { createReadStream, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { ROOT, writeJson } from "../lib/http";

export type NutrientGroup = "Vitamins" | "Minerals" | "Fats" | "Sugars" | "Plant compounds" | "Other";

/** CTD ChemicalID → [display name, group]. Industrial or drug-only forms are excluded. */
export const NUTRIENTS: Record<string, [string, NutrientGroup]> = {
  D014801: ["Vitamin A", "Vitamins"], D014212: ["Retinoic acid (active vitamin A)", "Vitamins"], D019207: ["Beta-carotene", "Vitamins"],
  D014807: ["Vitamin D", "Vitamins"], D002762: ["Vitamin D3 (cholecalciferol)", "Vitamins"], D002117: ["Calcitriol (active vitamin D)", "Vitamins"],
  D014810: ["Vitamin E", "Vitamins"], D024502: ["Alpha-tocopherol (vitamin E)", "Vitamins"], D024505: ["Tocopherols (vitamin E)", "Vitamins"],
  D001205: ["Vitamin C (ascorbic acid)", "Vitamins"], D005492: ["Folic acid", "Vitamins"], D014805: ["Vitamin B12", "Vitamins"],
  D025101: ["Vitamin B6", "Vitamins"], D012256: ["Riboflavin (vitamin B2)", "Vitamins"], D009525: ["Niacin (vitamin B3)", "Vitamins"],
  D009536: ["Niacinamide (vitamin B3)", "Vitamins"], D001710: ["Biotin", "Vitamins"], D002794: ["Choline", "Vitamins"], D024482: ["Vitamin K2", "Vitamins"],
  D012643: ["Selenium", "Minerals"], D018038: ["Sodium selenite (selenium)", "Minerals"], D012645: ["Selenomethionine (selenium)", "Minerals"],
  D015032: ["Zinc", "Minerals"], D019287: ["Zinc sulfate", "Minerals"], D019345: ["Zinc acetate", "Minerals"], C016837: ["Zinc chloride", "Minerals"],
  D007501: ["Iron", "Minerals"], C020748: ["Ferrous sulfate (iron)", "Minerals"], D002118: ["Calcium", "Minerals"], D008274: ["Magnesium", "Minerals"],
  D004281: ["DHA (omega-3)", "Fats"], D015118: ["EPA (omega-3)", "Fats"], D015525: ["Omega-3 fatty acids", "Fats"], D017962: ["Alpha-linolenic acid (omega-3)", "Fats"],
  D019787: ["Linoleic acid (omega-6)", "Fats"], D043371: ["Omega-6 fatty acids", "Fats"], D019308: ["Palmitic acid (saturated fat)", "Fats"],
  D019301: ["Oleic acid (monounsaturated fat)", "Fats"], D020148: ["Butyric acid", "Fats"], D002087: ["Butyrates", "Fats"],
  D005947: ["Glucose", "Sugars"], D005632: ["Fructose", "Sugars"],
  D000077185: ["Resveratrol", "Plant compounds"], D011794: ["Quercetin", "Plant compounds"], C045651: ["EGCG (green tea catechin)", "Plant compounds"],
  D019833: ["Genistein (soy isoflavone)", "Plant compounds"], D003474: ["Curcumin", "Plant compounds"], C016766: ["Sulforaphane", "Plant compounds"],
  D002392: ["Catechin", "Plant compounds"], D059808: ["Polyphenols", "Plant compounds"], C005273: ["Naringenin", "Plant compounds"],
  D047311: ["Luteolin", "Plant compounds"], C006552: ["Kaempferol", "Plant compounds"], D047310: ["Apigenin", "Plant compounds"],
  D000077276: ["Lycopene", "Plant compounds"], D004610: ["Ellagic acid", "Plant compounds"], D006569: ["Hesperidin", "Plant compounds"],
  C016517: ["Indole-3-carbinol", "Plant compounds"], C016392: ["Diindolylmethane (DIM)", "Plant compounds"], D002211: ["Capsaicin", "Plant compounds"],
  C012843: ["Cinnamaldehyde", "Plant compounds"], C007845: ["Gingerol", "Plant compounds"], C008922: ["Piperine", "Plant compounds"], D001599: ["Berberine", "Plant compounds"],
  D002110: ["Caffeine", "Other"], D003069: ["Coffee", "Other"], D000431: ["Alcohol (ethanol)", "Other"], D008550: ["Melatonin", "Other"],
  D013654: ["Taurine", "Other"], D008063: ["Alpha-lipoic acid", "Other"],
};

const MAX_PMIDS = 12;

/** Parse one simple, direct expression statement; null for complex reactions ("affects the reaction [...]"). */
export function parseInteraction(chemName: string, gene: string, text: string): 1 | -1 | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^${esc(chemName)} results in (increased|decreased) expression of ${esc(gene)} (mRNA|protein)$`));
  return m ? (m[1] === "increased" ? 1 : -1) : null;
}

async function main() {
  const file = join(ROOT, "pipeline/cache/bulk/ctd_chem_gene_ixns.tsv.gz");
  const agg = new Map<string, { up: Set<number>; down: Set<number> }>();
  let seen = 0, kept = 0;
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith("#")) continue;
    seen++;
    const c = line.split("\t"); // ChemicalName ChemicalID CasRN GeneSymbol GeneID GeneForms Organism OrganismID Interaction InteractionActions PubMedIDs
    if (c[7] !== "9606" || !(c[1] in NUTRIENTS)) continue;
    const dir = parseInteraction(c[0], c[3], c[8]);
    if (!dir) continue;
    const k = `${c[1]}|${c[3]}`;
    const a = agg.get(k) ?? agg.set(k, { up: new Set(), down: new Set() }).get(k)!;
    for (const p of c[10].split("|").map(Number).filter(Boolean)) (dir === 1 ? a.up : a.down).add(p);
    kept++;
  }
  const ids = Object.keys(NUTRIENTS);
  // row: [nutrientIdx, gene, upPmidCount, downPmidCount, pmids(up to 12, up first)]
  const rows = [...agg].map(([k, v]) => {
    const [chem, gene] = k.split("|");
    const pm = [...[...v.up].sort((a, b) => b - a), ...[...v.down].sort((a, b) => b - a)].slice(0, MAX_PMIDS);
    return [ids.indexOf(chem), gene, v.up.size, v.down.size, pm];
  });
  const version = statSync(file).mtime.toISOString().slice(0, 10);
  writeJson("pipeline/out/nutrigenomics.json", { version, retrievedAt: new Date().toISOString().slice(0, 10), nutrients: ids.map((i) => [i, ...NUTRIENTS[i]]), rows });
  console.log(`CTD rows ${seen.toLocaleString()}; kept ${kept.toLocaleString()} human nutrient expression statements → ${rows.length.toLocaleString()} nutrient–gene pairs`);
}

if (process.argv[1]?.endsWith("nutrigenomics.ts")) main().catch((e) => { console.error(e); process.exit(1); });

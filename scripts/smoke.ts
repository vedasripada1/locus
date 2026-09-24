// Browser smoke test against the production build (vite preview must be running).
// Uses the locally installed Chrome; no browser download. Usage: npm run smoke [-- <outdir>]
import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:4317/";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = process.argv[2] ?? ".";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
let failed = false;
for (const demo of ["23andme", "ancestrydna"]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const problems: string[] = [];
  const requests: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") problems.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) requests.push(r.url()); });
  await page.goto(`${BASE}#demo=${demo}`, { waitUntil: "load" });
  try {
    await page.waitForFunction(() => /confirm with a doctor/i.test(document.body.innerText), { timeout: 60000 });
  } catch { problems.push("report did not render within 15s"); }
  // Summary first.
  await page.waitForFunction(() => /confirm with a doctor/i.test(document.body.innerText), { timeout: 60000 }).catch(() => problems.push("summary headline did not render"));
  // Structured search from the filter bar.
  await page.type(".filter-row input[type=search]", "BRCA1");
  await page.waitForFunction(() => /BRCA1: coverage/.test(document.body.innerText), { timeout: 10000 }).catch(() => problems.push("search did not answer BRCA1 coverage"));
  // Category filter.
  await page.evaluate(() => ([...document.querySelectorAll("button.seg-btn")].find((b) => b.textContent?.startsWith("Health findings")) as HTMLElement).click());
  // Appendix tab: technical sections.
  await page.evaluate(() => ([...document.querySelectorAll("button.tab")].find((b) => /appendix/i.test(b.textContent ?? "")) as HTMLElement).click());
  const t0 = Date.now();
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("genome-wide clinvar screen"), { timeout: 60000 }).catch(() => problems.push("genome-wide ClinVar screen did not render"));
  const rendered = Date.now() - t0;
  // Explorer: switch the toolbar section and check rows.
  await page.select(".toolbar select", "explorer");
  const rows = await page.$$eval("table tbody tr", (trs) => trs.length).catch(() => 0);
  if (rows < 1) problems.push("explorer shows no rows");
  // Papers: open the first paper list and wait for titles from the local index.
  await page.select(".toolbar select", "clinical");
  await page.evaluate(() => { const s = [...document.querySelectorAll("summary")].find((x) => x.textContent?.startsWith("Papers for this allele")); (s as HTMLElement | undefined)?.click(); });
  await page.waitForFunction(() => document.querySelectorAll("ul.papers li").length > 0, { timeout: 30000 }).catch(() => problems.push("paper list did not load"));
  const papers = await page.$$eval("ul.papers li", (li) => li.length);
  await page.select(".toolbar select", "all");
  const accuracy = await page.evaluate(() => (document.body.innerText.match(/Accuracy check:[^\n]*/) ?? [""])[0]);
  if (!accuracy) problems.push("accuracy check missing");
  const text = await page.evaluate(() => document.body.innerText);
  console.log(`  ${accuracy.slice(0, 220)}`);
  console.log(`  bulk tiers rendered +${rendered} ms; explorer rows ${rows}; papers listed ${papers}`);
  await page.screenshot({ path: `${out}/smoke-${demo}.png`, fullPage: true });
  // Delete control: returns to the upload screen.
  page.on("dialog", (d) => d.accept());
  const del = await page.$("button.btn.danger");
  if (del) { await del.click(); await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("drop your raw data file here"), { timeout: 5000 }).catch(() => problems.push("delete did not clear the report")); }
  const ok = !problems.filter((p) => !p.startsWith("warn")).length && !requests.length;
  failed ||= !ok;
  console.log(`${demo}: ${ok ? "OK" : "FAIL"} · ${text.length} chars · external requests: ${requests.length}`);
  for (const p of [...problems, ...requests.map((r) => `external request: ${r}`)]) console.log(`  ${p}`);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

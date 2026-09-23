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
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("clinically significant findings"), { timeout: 15000 });
  } catch { problems.push("report did not render within 15s"); }
  const text = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: `${out}/smoke-${demo}.png`, fullPage: true });
  // Delete control: returns to the upload screen.
  page.on("dialog", (d) => d.accept());
  const del = await page.$("button.btn.danger");
  if (del) { await del.click(); await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("drop your raw data file here"), { timeout: 5000 }).catch(() => problems.push("delete did not clear the report")); }
  const ok = !problems.length && !requests.length;
  failed ||= !ok;
  console.log(`${demo}: ${ok ? "OK" : "FAIL"} · ${text.length} chars · external requests: ${requests.length}`);
  for (const p of [...problems, ...requests.map((r) => `external request: ${r}`)]) console.log(`  ${p}`);
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

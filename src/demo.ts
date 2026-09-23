/** Synthetic demo files are static assets on this origin (public/demo). */
export const loadDemo = (which: "23andme" | "ancestrydna") =>
  fetch(new URL(`${import.meta.env.BASE_URL}demo/synthetic-${which}.txt`, location.href)).then((r) => {
    if (!r.ok) throw new Error(`demo file missing (HTTP ${r.status})`);
    return r.text();
  });

export interface Manifest { builtAt: string; clinvar: { version: string; variants: number }; gwas: { version: string; groups: number; sites: number } | null; papers: number }
export const loadManifest = (): Promise<Manifest | null> =>
  fetch(new URL(`${import.meta.env.BASE_URL}data/manifest.json`, location.href)).then((r) => (r.ok ? r.json() : null)).catch(() => null);

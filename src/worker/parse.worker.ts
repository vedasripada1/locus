// Runs off the main thread. Receives the File, returns the ParsedGenome.
// Nothing here touches the network; the raw text is discarded after parsing.
import { unzipSync, strFromU8 } from "fflate";
import { parseGenotypeText, ParseError } from "../core/parse";

export type WorkerIn = { file?: File; text?: string; keep: string[] };

async function readText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) return new TextDecoder().decode(buf);
  const entries = Object.entries(unzipSync(buf)).filter(([n]) => /\.(txt|csv|tsv)$/i.test(n) && !n.startsWith("__MACOSX"));
  if (!entries.length) throw new ParseError("The .zip contains no .txt raw data file.", "zip-empty");
  entries.sort((a, b) => b[1].length - a[1].length);
  return strFromU8(entries[0][1]);
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  try {
    const text = e.data.text ?? (await readText(e.data.file!));
    const genome = parseGenotypeText(text, new Set(e.data.keep));
    (self as unknown as Worker).postMessage({ ok: true, genome });
  } catch (err) {
    const known = err instanceof ParseError;
    (self as unknown as Worker).postMessage({ ok: false, error: known ? err.message : `Unexpected error while reading the file: ${(err as Error).message}`, code: known ? err.code : "internal" });
  }
};

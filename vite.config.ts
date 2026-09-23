/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Production builds get a strict Content-Security-Policy: the page may only fetch
// its own static evidence files (connect-src 'self'; there is no server that accepts
// data), so genotype data cannot leave the browser even by accident. Dev omits it for HMR.
const CSP = [
  "default-src 'self'", "connect-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", "worker-src 'self' blob:", "form-action 'none'", "base-uri 'none'",
].join("; ");

const csp = (): Plugin => ({
  name: "locus-csp",
  transformIndexHtml: { order: "post", handler: (html, ctx) =>
    html.replace("<!--%CSP%-->", ctx.server ? "" : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`) },
});

export default defineConfig({
  plugins: [react(), csp()],
  worker: { format: "es" },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  test: { include: ["tests/**/*.test.ts"] },
});

/** Reading floor-plan files in the webview: images as-is, PDF pages rendered to PNG. */
import type { Rect } from "./geometry";

export const MAX_PLAN_BYTES = 25 * 1024 * 1024;
/** Width PDF pages are rendered at (sharp at typical zoom levels). */
const PDF_RENDER_WIDTH = 2400;

export interface PlanImage {
  name: string;
  data: Uint8Array;
  width: number;
  height: number;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

async function imageSize(
  bytes: Uint8Array,
  type: string,
): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // SVGs without width/height report 0; fall back to a sensible canvas size.
    return { width: img.naturalWidth || 1600, height: img.naturalHeight || 1200 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Render one page of a PDF to PNG with pdf.js (loaded on demand). */
async function pdfPage(
  bytes: Uint8Array,
  page: number,
): Promise<{ data: Uint8Array; width: number; height: number; pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdf.js 5+ never evaluates code from the document. Its WASM image decoders stay
  // off: they are fetched at runtime, and connect-src only allows IPC.
  const task = pdfjs.getDocument({ data: bytes.slice(), useWasm: false, useSystemFonts: true });
  const doc = await task.promise;
  try {
    const n = Math.min(Math.max(1, page), doc.numPages);
    const p = await doc.getPage(n);
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: PDF_RENDER_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("The page could not be rendered.");
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
      pages: doc.numPages,
    };
  } finally {
    void task.destroy();
  }
}

/** Read a chosen file; PDFs become a PNG of `page`. */
export async function readPlanFile(file: File, page = 1): Promise<PlanImage & { pages: number }> {
  if (file.size > MAX_PLAN_BYTES) throw new Error("Floor plans can be up to 25 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPdf(bytes)) {
    const r = await pdfPage(bytes, page);
    return { name: file.name.replace(/\.pdf$/i, `-p${page}.png`), ...r };
  }
  const type = file.type || (/\.svg$/i.test(file.name) ? "image/svg+xml" : "image/png");
  const size = await imageSize(bytes, type);
  return { name: file.name, data: bytes, ...size, pages: 1 };
}

/** Scale range offered by the placement slider. */
export const PLAN_SCALE = { min: 0.1, max: 4 } as const;

/**
 * Placement that puts a new plan behind the floor's devices: covering their bounds
 * with a margin, keeping the image's aspect ratio. Null on an empty floor.
 */
export function fitPlan(
  width: number,
  height: number,
  content: Rect | null,
): { scale: number; x: number; y: number } | null {
  if (!content || width <= 0 || height <= 0) return null;
  const pad = 64;
  const scale = Math.min(
    PLAN_SCALE.max,
    Math.max(PLAN_SCALE.min, (content.w + 2 * pad) / width, (content.h + 2 * pad) / height),
  );
  const round = (n: number) => Math.round(n * 100) / 100;
  // Centered on the content.
  return {
    scale: round(scale),
    x: Math.round(content.x + content.w / 2 - (width * scale) / 2),
    y: Math.round(content.y + content.h / 2 - (height * scale) / 2),
  };
}

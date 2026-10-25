import { aiEnabled, describeAiError } from "@/lib/ai/client";
import type { ExtractionResult } from "@/lib/domain/types";
import { extractWithClaude } from "./claude";
import { parseGrid } from "./grid";
import { pdfToRows } from "./pdf-text";
import { parseJsonDocument } from "./schema";
import { csvToRows, xlsxToRows } from "./spreadsheet";

export const ACCEPTED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "text/csv": "csv",
  "application/vnd.ms-excel": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/json": "json",
  "text/plain": "csv",
};

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function kindOf(fileName: string, mime: string): "pdf" | "image" | "csv" | "xlsx" | "json" | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["csv", "tsv", "txt"].includes(ext)) return "csv";
  if (ext === "xlsx") return "xlsx";
  if (ext === "json") return "json";
  return (ACCEPTED_TYPES[mime] as ReturnType<typeof kindOf>) ?? null;
}

function imageMime(fileName: string, mime: string): string {
  if (mime.startsWith("image/")) return mime === "image/jpg" ? "image/jpeg" : mime;
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

/** Below this coverage, the layout parser hands spreadsheets to Claude when available. */
const LAYOUT_TRUST = 0.7;

/**
 * Route a file to the best available reader.
 *
 * - JSON: imported directly.
 * - CSV / XLSX: layout parser; Claude only if the sheet's layout is not recognised.
 * - PDF: Claude when configured (handles scans, stamps, odd layouts); otherwise
 *   the layout parser reads digital PDFs. If Claude fails, we fall back to the
 *   layout parser and say so.
 * - Images: Claude only.
 */
export async function extractFile(fileName: string, mime: string, data: Buffer): Promise<ExtractionResult> {
  const kind = kindOf(fileName, mime);
  if (!kind) throw new Error(`Unsupported file type: ${fileName}`);

  if (kind === "json") {
    const document = parseJsonDocument(JSON.parse(data.toString("utf8")));
    return { document, method: "structured", confidence: 1, warnings: [] };
  }

  if (kind === "csv" || kind === "xlsx") {
    const { rows, csv } = kind === "csv" ? csvToRows(data.toString("utf8")) : await xlsxToRows(data);
    const local = { ...parseGrid(rows, fileName, 0.5), method: "structured" as const };
    if (local.confidence >= LAYOUT_TRUST || !aiEnabled()) return local;
    try {
      return await extractWithClaude({ kind: "text", text: csv }, fileName);
    } catch (err) {
      return { ...local, warnings: [...local.warnings, `AI extraction unavailable: ${describeAiError(err).message}`] };
    }
  }

  if (kind === "image") {
    if (!aiEnabled()) {
      throw new Error("Photos and scans need AI extraction. Add ANTHROPIC_API_KEY, or upload the digital PDF / spreadsheet instead.");
    }
    try {
      return await extractWithClaude({ kind: "image", mediaType: imageMime(fileName, mime), data }, fileName);
    } catch (err) {
      throw describeAiError(err);
    }
  }

  // PDF
  const layout = async () => {
    const { rows, textLength } = await pdfToRows(data);
    if (textLength < 40) {
      throw new Error("This PDF has no text layer (it is a scan). Enable AI extraction to read scanned documents.");
    }
    return parseGrid(rows, fileName);
  };
  if (!aiEnabled()) return layout();
  try {
    return await extractWithClaude({ kind: "pdf", mediaType: "application/pdf", data }, fileName);
  } catch (err) {
    const ai = describeAiError(err);
    try {
      const res = await layout();
      return { ...res, warnings: [`AI extraction failed (${ai.message}); read with the layout parser instead.`, ...res.warnings] };
    } catch {
      throw ai;
    }
  }
}

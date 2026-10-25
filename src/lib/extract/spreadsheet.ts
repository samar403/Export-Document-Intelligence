import ExcelJS from "exceljs";
import Papa from "papaparse";
import type { Row } from "./grid";

function gridToRows(grid: string[][]): Row[] {
  return grid
    .map((cells, y) => ({
      y,
      cells: cells
        .map((text, x) => ({ text: (text ?? "").toString().trim(), x0: x, x1: x + 0.9 }))
        .filter((c) => c.text !== ""),
    }))
    .filter((r) => r.cells.length > 0);
}

export function csvToRows(text: string): { rows: Row[]; csv: string } {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: false });
  return { rows: gridToRows(parsed.data), csv: text };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
  }
  return String(v);
}

/** First non-empty worksheet as rows, plus a CSV rendering for the AI path. */
export async function xlsxToRows(data: Buffer): Promise<{ rows: Row[]; csv: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return { rows: [], csv: "" };
  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellText(cell.value);
    });
    grid[rowNumber - 1] = Array.from(cells, (c) => c ?? "");
  });
  const dense = Array.from(grid, (r) => r ?? []);
  return { rows: gridToRows(dense), csv: Papa.unparse(dense) };
}

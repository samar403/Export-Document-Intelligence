import { getDocumentProxy } from "unpdf";
import type { Cell, Row } from "./grid";

interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Pull positioned text out of a digital PDF and rebuild visual rows. Items on
 * the same baseline (±2.5pt) form a row; touching items within a row are
 * merged into one cell so "Invoice No: 123" stays together while table
 * columns stay apart. Pages are stacked top to bottom.
 */
export async function pdfToRows(data: Uint8Array): Promise<{ rows: Row[]; pages: number; textLength: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const rows: Row[] = [];
  let textLength = 0;
  let pageOffset = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = (content.items as unknown[])
      .filter((it): it is TextItemLike => typeof (it as TextItemLike).str === "string" && (it as TextItemLike).str.trim() !== "")
      .map((it) => ({
        text: it.str,
        x0: it.transform[4],
        x1: it.transform[4] + it.width,
        y: pageOffset + (viewport.height - it.transform[5]),
        size: Math.abs(it.transform[3]) || it.height || 8,
      }));
    textLength += items.reduce((a, i) => a + i.text.length, 0);
    items.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const pageRows: { y: number; items: typeof items }[] = [];
    for (const it of items) {
      const r = pageRows.find((row) => Math.abs(row.y - it.y) <= 2.5);
      if (r) r.items.push(it);
      else pageRows.push({ y: it.y, items: [it] });
    }
    for (const r of pageRows) {
      r.items.sort((a, b) => a.x0 - b.x0);
      const cells: Cell[] = [];
      for (const it of r.items) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x0 - last.x1 : Infinity;
        // Merge when the gap is no wider than ~one space at this font size.
        if (last && gap < it.size * 0.6) {
          last.text += gap > it.size * 0.12 ? ` ${it.text}` : it.text;
          last.x1 = it.x1;
        } else {
          cells.push({ text: it.text, x0: it.x0, x1: it.x1 });
        }
      }
      rows.push({ y: r.y, cells: cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text) });
    }
    pageOffset += viewport.height;
  }
  rows.sort((a, b) => a.y - b.y);
  return { rows, pages: pdf.numPages, textLength };
}

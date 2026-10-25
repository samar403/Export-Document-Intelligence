import { SAMPLE_PACKS } from "../src/lib/samples/packs";
import { renderDocumentPdf } from "../src/lib/samples/pdf";
import { pdfToRows } from "../src/lib/extract/pdf-text";
import { parseGrid } from "../src/lib/extract/grid";
import { reconcile } from "../src/lib/engine/reconcile";
import { writeFileSync, mkdirSync } from "node:fs";

const deep = (a: unknown, b: unknown, path = ""): string[] => {
  if (a === b) return [];
  if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-6) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => deep((a as any)[k], (b as any)[k], `${path}.${k}`));
  }
  return [`${path}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`];
};
mkdirSync("/tmp/claude-0/pdfs", { recursive: true });
for (const s of SAMPLE_PACKS) {
  const docs = [];
  for (const [i, d] of s.documents.entries()) {
    const bytes = await renderDocumentPdf(d.document);
    writeFileSync(`/tmp/claude-0/pdfs/${s.slug}-${i}.pdf`, bytes);
    const { rows } = await pdfToRows(bytes);
    const res = parseGrid(rows, d.fileName);
    const diffs = deep(d.document, res.document);
    console.log(`${s.slug}/${d.fileName}: conf ${res.confidence} diffs ${diffs.length}`);
    for (const x of diffs.slice(0, 12)) console.log("   ", x);
    docs.push({ id: `d${i}`, fileName: d.fileName, extraction: res });
  }
  const r = reconcile(docs);
  console.log(` => ${r.verdict} ${r.score} issues ${r.issues.length}`);
}

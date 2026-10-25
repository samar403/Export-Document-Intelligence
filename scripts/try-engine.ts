import { SAMPLE_PACKS } from "../src/lib/samples/packs";
import { reconcile } from "../src/lib/engine/reconcile";
for (const s of SAMPLE_PACKS) {
  const docs = s.documents.map((d, i) => ({ id: `d${i}`, fileName: d.fileName, extraction: { document: d.document, method: "sample" as const, confidence: 1, warnings: [] } }));
  const r = reconcile(docs);
  console.log(`\n== ${s.slug}: score ${r.score} ${r.verdict} VaR ${r.valueAtRisk} lines ${r.lineMatches.length}`);
  for (const i of r.issues) console.log(` [${i.severity}] ${i.id} :: ${i.title}`);
}

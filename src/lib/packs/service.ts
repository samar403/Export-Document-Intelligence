import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "@/lib/auth";
import { chargePack } from "@/lib/billing/plans";
import { db, newId, now, UPLOAD_DIR } from "@/lib/db";
import {
  DEFAULT_RULE_SETTINGS,
  type ExtractedDocument,
  type ExtractionResult,
  type IssueStatus,
  type PackDocument,
  type ReconciliationReport,
  type RuleSettings,
} from "@/lib/domain/types";
import { applyDecisions, reconcile } from "@/lib/engine/reconcile";
import { extractFile } from "@/lib/extract";
import { parseGrid } from "@/lib/extract/grid";
import { pdfToRows } from "@/lib/extract/pdf-text";
import { getSample } from "@/lib/samples/packs";
import { renderDocumentPdf } from "@/lib/samples/pdf";
import type { AdvicePlan } from "@/lib/ai/advisor";

export type PackStatus = "draft" | "processing" | "ready" | "failed" | "blocked";
export type DocStatus = "queued" | "extracting" | "ready" | "failed";

export interface PackRow {
  id: string;
  workspace_id: string;
  name: string;
  reference: string | null;
  route: string | null;
  status: PackStatus;
  report_json: string | null;
  advice_json: string | null;
  score: number | null;
  verdict: string | null;
  billed: number;
  created_at: string;
  updated_at: string;
  analyzed_at: string | null;
}

export interface DocRow {
  id: string;
  pack_id: string;
  file_name: string;
  mime: string;
  size: number;
  storage_path: string | null;
  status: DocStatus;
  error: string | null;
  extraction_json: string | null;
  edited: number;
  created_at: string;
}

export interface Decision {
  issue_id: string;
  status: IssueStatus;
  note: string | null;
  decided_at: string;
}

export interface PackView {
  pack: PackRow & { docCount: number };
  documents: (Omit<DocRow, "extraction_json"> & { extraction: ExtractionResult | null })[];
  report: ReconciliationReport | null;
  advice: AdvicePlan | null;
  decisions: Decision[];
  activity: { id: string; kind: string; message: string; created_at: string }[];
  live: { score: number; verdict: string; valueAtRisk: number; open: number } | null;
}

export function workspaceSettings(ws: Pick<Workspace, "settings_json">): RuleSettings {
  try {
    return { ...DEFAULT_RULE_SETTINGS, ...(JSON.parse(ws.settings_json || "{}").rules ?? {}) };
  } catch {
    return DEFAULT_RULE_SETTINGS;
  }
}

export function saveWorkspaceSettings(wsId: string, rules: RuleSettings) {
  const row = db().prepare("SELECT settings_json FROM workspaces WHERE id = ?").get(wsId) as { settings_json: string };
  const settings = { ...JSON.parse(row.settings_json || "{}"), rules };
  db().prepare("UPDATE workspaces SET settings_json = ? WHERE id = ?").run(JSON.stringify(settings), wsId);
}

function log(packId: string, kind: string, message: string, userId: string | null = null) {
  db().prepare("INSERT INTO activity (id, pack_id, user_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(newId("act"), packId, userId, kind, message, now());
}

// ------------------------------------------------------------------ Reads ---

export function listPacks(wsId: string) {
  return db()
    .prepare(
      `SELECT p.id, p.name, p.reference, p.route, p.status, p.score, p.verdict, p.created_at, p.updated_at, p.analyzed_at,
              (SELECT COUNT(*) FROM documents d WHERE d.pack_id = p.id) AS docCount,
              json_extract(p.report_json, '$.valueAtRisk') AS valueAtRisk,
              json_extract(p.report_json, '$.currency') AS currency,
              json_extract(p.report_json, '$.stats.blockers') AS blockers,
              json_extract(p.report_json, '$.stats.warnings') AS warnings
         FROM packs p WHERE p.workspace_id = ? ORDER BY p.created_at DESC`,
    )
    .all(wsId) as unknown as (Pick<PackRow, "id" | "name" | "reference" | "route" | "status" | "score" | "verdict" | "created_at" | "updated_at" | "analyzed_at"> & {
    docCount: number; valueAtRisk: number | null; currency: string | null; blockers: number | null; warnings: number | null;
  })[];
}

export function getPackRow(wsId: string, packId: string): PackRow | undefined {
  return db().prepare("SELECT * FROM packs WHERE id = ? AND workspace_id = ?").get(packId, wsId) as PackRow | undefined;
}

function docRows(packId: string): DocRow[] {
  return db().prepare("SELECT * FROM documents WHERE pack_id = ? ORDER BY created_at, rowid").all(packId) as unknown as DocRow[];
}

export function decisionsFor(packId: string): Decision[] {
  return db().prepare("SELECT issue_id, status, note, decided_at FROM decisions WHERE pack_id = ?").all(packId) as unknown as Decision[];
}

export function getPackView(wsId: string, packId: string): PackView | null {
  const pack = getPackRow(wsId, packId);
  if (!pack) return null;
  const docs = docRows(packId);
  const report = pack.report_json ? (JSON.parse(pack.report_json) as ReconciliationReport) : null;
  const decisions = decisionsFor(packId);
  const closed = new Set(decisions.filter((d) => d.status !== "open").map((d) => d.issue_id));
  const live = report ? applyDecisions(report, closed) : null;
  return {
    pack: { ...pack, docCount: docs.length },
    documents: docs.map(({ extraction_json, ...d }) => ({ ...d, extraction: extraction_json ? (JSON.parse(extraction_json) as ExtractionResult) : null })),
    report,
    advice: pack.advice_json ? (JSON.parse(pack.advice_json) as AdvicePlan) : null,
    decisions,
    activity: db().prepare("SELECT id, kind, message, created_at FROM activity WHERE pack_id = ? ORDER BY created_at DESC LIMIT 50").all(packId) as unknown as PackView["activity"],
    live: live ? { score: live.score, verdict: live.verdict, valueAtRisk: live.valueAtRisk, open: live.open.length } : null,
  };
}

export async function readDocumentFile(wsId: string, docId: string): Promise<{ doc: DocRow; data: Buffer } | null> {
  const doc = db()
    .prepare("SELECT d.* FROM documents d JOIN packs p ON p.id = d.pack_id WHERE d.id = ? AND p.workspace_id = ?")
    .get(docId, wsId) as DocRow | undefined;
  if (!doc?.storage_path) return null;
  const full = path.join(UPLOAD_DIR, doc.storage_path);
  if (!full.startsWith(UPLOAD_DIR)) return null;
  return { doc, data: await readFile(full) };
}

// ----------------------------------------------------------------- Writes ---

export function createPack(wsId: string, userId: string | null, input: { name: string; reference?: string | null; route?: string | null }): string {
  const id = newId("pk");
  const ts = now();
  db().prepare("INSERT INTO packs (id, workspace_id, name, reference, route, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)").run(
    id, wsId, input.name.trim() || "Untitled shipment", input.reference?.trim() || null, input.route?.trim() || null, userId, ts, ts,
  );
  log(id, "created", "Pack created", userId);
  return id;
}

export function updatePack(wsId: string, packId: string, patch: { name?: string; reference?: string | null; route?: string | null }) {
  const p = getPackRow(wsId, packId);
  if (!p) return;
  db().prepare("UPDATE packs SET name = ?, reference = ?, route = ?, updated_at = ? WHERE id = ?").run(
    patch.name?.trim() || p.name, patch.reference === undefined ? p.reference : patch.reference, patch.route === undefined ? p.route : patch.route, now(), packId,
  );
}

export async function deletePack(wsId: string, packId: string) {
  const p = getPackRow(wsId, packId);
  if (!p) return;
  db().prepare("DELETE FROM packs WHERE id = ?").run(packId);
  await rm(path.join(UPLOAD_DIR, packId), { recursive: true, force: true });
}

export async function addDocument(packId: string, file: { name: string; type: string; data: Buffer }, userId: string | null): Promise<string> {
  const id = newId("doc");
  const safe = file.name.replace(/[^\w.\- ()]+/g, "_").slice(-120);
  const rel = path.join(packId, `${id}-${safe}`);
  await mkdir(path.join(UPLOAD_DIR, packId), { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, rel), file.data);
  db().prepare("INSERT INTO documents (id, pack_id, file_name, mime, size, storage_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)").run(
    id, packId, file.name, file.type || "application/octet-stream", file.data.length, rel, now(),
  );
  db().prepare("UPDATE packs SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), packId);
  log(packId, "upload", `Uploaded ${file.name}`, userId);
  return id;
}

export function removeDocument(wsId: string, docId: string) {
  const row = db().prepare("SELECT d.pack_id, d.file_name FROM documents d JOIN packs p ON p.id = d.pack_id WHERE d.id = ? AND p.workspace_id = ?").get(docId, wsId) as
    | { pack_id: string; file_name: string }
    | undefined;
  if (!row) return null;
  db().prepare("DELETE FROM documents WHERE id = ?").run(docId);
  log(row.pack_id, "remove", `Removed ${row.file_name}`);
  return row.pack_id;
}

async function extractOne(doc: DocRow) {
  db().prepare("UPDATE documents SET status = 'extracting', error = NULL WHERE id = ?").run(doc.id);
  try {
    const data = await readFile(path.join(UPLOAD_DIR, doc.storage_path!));
    const result = await extractFile(doc.file_name, doc.mime, data);
    db().prepare("UPDATE documents SET status = 'ready', extraction_json = ? WHERE id = ?").run(JSON.stringify(result), doc.id);
    log(doc.pack_id, "extracted", `Read ${doc.file_name} as ${result.document.docType.replace(/_/g, " ")} (${result.method}, ${Math.round(result.confidence * 100)}% confidence)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db().prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?").run(message, doc.id);
    log(doc.pack_id, "error", `Could not read ${doc.file_name}: ${message}`);
  }
}

/** Extract every queued document (3 at a time), then reconcile. Safe to call repeatedly. */
export async function processPack(ws: Workspace, packId: string) {
  const queued = docRows(packId).filter((d) => d.status === "queued");
  const pool = [...queued];
  await Promise.all(
    Array.from({ length: Math.min(3, pool.length) }, async () => {
      for (let d = pool.shift(); d; d = pool.shift()) await extractOne(d);
    }),
  );
  analyzePack(ws, packId);
}

export function retryDocument(wsId: string, docId: string): string | null {
  const row = db().prepare("SELECT d.pack_id FROM documents d JOIN packs p ON p.id = d.pack_id WHERE d.id = ? AND p.workspace_id = ?").get(docId, wsId) as { pack_id: string } | undefined;
  if (!row) return null;
  db().prepare("UPDATE documents SET status = 'queued', error = NULL WHERE id = ?").run(docId);
  db().prepare("UPDATE packs SET status = 'processing' WHERE id = ?").run(row.pack_id);
  return row.pack_id;
}

/**
 * Reconcile the pack's ready documents. The first successful analysis of a
 * pack is metered; re-analysis after edits or new uploads is free.
 */
export function analyzePack(ws: Workspace, packId: string, userId: string | null = null): { ok: boolean; reason?: string } {
  const docs = docRows(packId);
  if (docs.some((d) => d.status === "queued" || d.status === "extracting")) return { ok: false, reason: "Documents are still being read." };
  const ready = docs.filter((d) => d.status === "ready" && d.extraction_json);
  if (ready.length === 0) {
    db().prepare("UPDATE packs SET status = ?, updated_at = ? WHERE id = ?").run(docs.length ? "failed" : "draft", now(), packId);
    return { ok: false, reason: "No readable documents." };
  }
  const pack = db().prepare("SELECT billed FROM packs WHERE id = ?").get(packId) as { billed: number };
  if (!pack.billed) {
    if (!chargePack(ws, packId)) {
      db().prepare("UPDATE packs SET status = 'blocked', updated_at = ? WHERE id = ?").run(now(), packId);
      return { ok: false, reason: "No pack credits left." };
    }
    db().prepare("UPDATE packs SET billed = 1 WHERE id = ?").run(packId);
  }
  const packDocs: PackDocument[] = ready.map((d) => ({ id: d.id, fileName: d.file_name, extraction: JSON.parse(d.extraction_json!) as ExtractionResult }));
  const fresh = db().prepare("SELECT settings_json FROM workspaces WHERE id = ?").get(ws.id) as { settings_json: string };
  const report = reconcile(packDocs, workspaceSettings(fresh));
  const closed = new Set(decisionsFor(packId).filter((d) => d.status !== "open").map((d) => d.issue_id));
  const live = applyDecisions(report, closed);
  db().prepare("UPDATE packs SET status = 'ready', report_json = ?, advice_json = NULL, score = ?, verdict = ?, analyzed_at = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(report), live.score, live.verdict, now(), now(), packId,
  );
  log(packId, "analyzed", `Cross-checked ${packDocs.length} documents: ${report.stats.blockers} blockers, ${report.stats.warnings} warnings, ${report.stats.advisories} advisories`, userId);
  return { ok: true };
}

export function saveExtraction(wsId: string, docId: string, document: ExtractedDocument, userId: string | null): string | null {
  const row = db().prepare("SELECT d.pack_id, d.file_name, d.extraction_json FROM documents d JOIN packs p ON p.id = d.pack_id WHERE d.id = ? AND p.workspace_id = ?").get(docId, wsId) as
    | { pack_id: string; file_name: string; extraction_json: string | null }
    | undefined;
  if (!row) return null;
  const prev = row.extraction_json ? (JSON.parse(row.extraction_json) as ExtractionResult) : null;
  const next: ExtractionResult = { document, method: "manual", confidence: 1, warnings: prev?.warnings ?? [] };
  db().prepare("UPDATE documents SET extraction_json = ?, status = 'ready', error = NULL, edited = 1 WHERE id = ?").run(JSON.stringify(next), docId);
  log(row.pack_id, "edit", `Corrected extracted data on ${row.file_name}`, userId);
  return row.pack_id;
}

export function setDecision(wsId: string, packId: string, issueId: string, status: IssueStatus, note: string | null, userId: string | null) {
  const pack = getPackRow(wsId, packId);
  if (!pack) return false;
  if (status === "open") db().prepare("DELETE FROM decisions WHERE pack_id = ? AND issue_id = ?").run(packId, issueId);
  else
    db().prepare(
      "INSERT INTO decisions (pack_id, issue_id, status, note, user_id, decided_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pack_id, issue_id) DO UPDATE SET status = excluded.status, note = excluded.note, user_id = excluded.user_id, decided_at = excluded.decided_at",
    ).run(packId, issueId, status, note, userId, now());
  if (pack.report_json) {
    const report = JSON.parse(pack.report_json) as ReconciliationReport;
    const closed = new Set(decisionsFor(packId).filter((d) => d.status !== "open").map((d) => d.issue_id));
    const live = applyDecisions(report, closed);
    db().prepare("UPDATE packs SET score = ?, verdict = ?, updated_at = ? WHERE id = ?").run(live.score, live.verdict, now(), packId);
    const issue = report.issues.find((i) => i.id === issueId);
    if (issue) log(packId, "decision", `${status === "resolved" ? "Marked fixed" : status === "accepted" ? "Accepted risk on" : "Re-opened"}: ${issue.title}${note ? ` — “${note}”` : ""}`, userId);
  }
  return true;
}

export function saveAdvice(packId: string, advice: AdvicePlan) {
  db().prepare("UPDATE packs SET advice_json = ? WHERE id = ?").run(JSON.stringify(advice), packId);
}

/**
 * Create a pack from a bundled sample. The sample PDFs are rendered and read
 * back through the layout parser — the same path a real digital PDF takes —
 * so the original files are viewable alongside the extracted data.
 */
export async function createSamplePack(ws: Workspace, userId: string | null, slug: string): Promise<string | null> {
  const sample = getSample(slug);
  if (!sample) return null;
  const packId = createPack(ws.id, userId, { name: sample.name, reference: sample.reference, route: sample.route });
  for (const d of sample.documents) {
    const bytes = Buffer.from(await renderDocumentPdf(d.document));
    const docId = await addDocument(packId, { name: d.fileName, type: "application/pdf", data: bytes }, userId);
    const { rows } = await pdfToRows(bytes);
    const result = parseGrid(rows, d.fileName);
    db().prepare("UPDATE documents SET status = 'ready', extraction_json = ? WHERE id = ?").run(JSON.stringify(result), docId);
  }
  log(packId, "sample", `Loaded sample pack “${sample.name}”`, userId);
  analyzePack(ws, packId, userId);
  return packId;
}

export function workspaceStats(wsId: string) {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS packs,
              SUM(CASE WHEN verdict = 'cleared' THEN 1 ELSE 0 END) AS cleared,
              SUM(CASE WHEN verdict = 'hold' THEN 1 ELSE 0 END) AS held,
              COALESCE(SUM(json_extract(report_json, '$.stats.blockers') + json_extract(report_json, '$.stats.warnings')), 0) AS caught,
              COALESCE(SUM(json_extract(report_json, '$.valueAtRisk')), 0) AS valueAtRisk,
              (SELECT COUNT(*) FROM documents d JOIN packs p2 ON p2.id = d.pack_id WHERE p2.workspace_id = ?) AS documents
         FROM packs WHERE workspace_id = ?`,
    )
    .get(wsId, wsId) as { packs: number; cleared: number | null; held: number | null; caught: number; valueAtRisk: number; documents: number };
  return { ...r, cleared: r.cleared ?? 0, held: r.held ?? 0 };
}

import type { LineItem, LineMatch, PackDocument } from "@/lib/domain/types";
import { descriptionSimilarity, normHs, normRef, toBaseQuantity } from "./normalize";

/** Score how likely two line items describe the same goods, 0..1. */
export function lineScore(a: LineItem, b: LineItem): number {
  const skuA = normRef(a.sku);
  const skuB = normRef(b.sku);
  const desc = descriptionSimilarity(a.description, b.description);
  if (skuA && skuB) {
    if (skuA === skuB) return 1;
    // One SKU containing the other ("ACM-100" vs "ACM-100-BLK") is a strong hint.
    if (skuA.length >= 4 && skuB.length >= 4 && (skuA.includes(skuB) || skuB.includes(skuA))) {
      return Math.min(1, 0.75 + desc * 0.25);
    }
  }
  let score = desc;
  const hsA = normHs(a.hsCode).slice(0, 6);
  const hsB = normHs(b.hsCode).slice(0, 6);
  if (hsA.length === 6 && hsB.length === 6) score += hsA === hsB ? 0.15 : -0.1;
  const qa = toBaseQuantity(a.quantity, a.unit).qty;
  const qb = toBaseQuantity(b.quantity, b.unit).qty;
  if (qa != null && qb != null && qa === qb) score += 0.08;
  if (skuA && skuB && skuA !== skuB) score -= 0.25;
  return Math.max(0, Math.min(1, score));
}

const MATCH_THRESHOLD = 0.42;

function lineLabel(line: LineItem, fallback: number): string {
  const sku = line.sku?.trim();
  const desc = line.description?.trim();
  if (sku && desc) return `${sku} · ${desc}`;
  return sku || desc || `Line ${fallback}`;
}

/**
 * Align line items across documents. The first document with lines in
 * `order` becomes the anchor; every other document's lines are greedily
 * assigned to the best-scoring group (one line per document per group).
 * Lines that match nothing open a new group, so goods present on only one
 * document still surface.
 */
export function matchLines(docs: PackDocument[]): LineMatch[] {
  type Group = { members: Record<string, number>; lines: LineItem[]; score: number };
  const groups: Group[] = [];
  for (const doc of docs) {
    const lines = doc.extraction.document.lineItems;
    if (lines.length === 0) continue;
    if (groups.length === 0) {
      lines.forEach((l, i) => groups.push({ members: { [doc.id]: i }, lines: [l], score: 1 }));
      continue;
    }
    // Candidate pairs (lineIndex, groupIndex, score), best first.
    const pairs: { li: number; gi: number; s: number }[] = [];
    lines.forEach((line, li) => {
      groups.forEach((g, gi) => {
        if (doc.id in g.members) return;
        const s = Math.max(...g.lines.map((gl) => lineScore(gl, line)));
        if (s >= MATCH_THRESHOLD) pairs.push({ li, gi, s });
      });
    });
    pairs.sort((x, y) => y.s - x.s || x.li - y.li);
    const usedLines = new Set<number>();
    const usedGroups = new Set<number>();
    for (const p of pairs) {
      if (usedLines.has(p.li) || usedGroups.has(p.gi)) continue;
      usedLines.add(p.li);
      usedGroups.add(p.gi);
      const g = groups[p.gi];
      g.members[doc.id] = p.li;
      g.lines.push(lines[p.li]);
      g.score = Math.min(g.score, p.s);
    }
    lines.forEach((l, li) => {
      if (!usedLines.has(li)) groups.push({ members: { [doc.id]: li }, lines: [l], score: 1 });
    });
  }
  return groups.map((g, i) => ({
    key: `L${i + 1}`,
    label: lineLabel(g.lines[0], i + 1),
    members: g.members,
    matchScore: Math.round(g.score * 100) / 100,
  }));
}

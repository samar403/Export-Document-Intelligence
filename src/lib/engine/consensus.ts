import type { DocType } from "@/lib/domain/types";

export interface Reading<T> {
  docId: string;
  docType: DocType;
  value: T;
}

export interface ConsensusResult<T> {
  /** Readings grouped by equivalence, largest (or most authoritative) first. */
  groups: Reading<T>[][];
  consensus: Reading<T>[] | null;
  outliers: Reading<T>[];
}

/**
 * Group readings of the same fact by equivalence and decide which group is
 * most likely right. The largest group wins; ties go to the group containing
 * the most authoritative document for that field (e.g. the PO is the authority
 * on agreed unit price, the B/L on the vessel).
 */
export function consensus<T>(
  readings: Reading<T>[],
  equal: (a: T, b: T) => boolean,
  authority: DocType[] = [],
): ConsensusResult<T> {
  const groups: Reading<T>[][] = [];
  for (const r of readings) {
    const g = groups.find((grp) => equal(grp[0].value, r.value));
    if (g) g.push(r);
    else groups.push([r]);
  }
  const rank = (grp: Reading<T>[]) => {
    let best = authority.length;
    for (const r of grp) {
      const i = authority.indexOf(r.docType);
      if (i >= 0 && i < best) best = i;
    }
    return best;
  };
  groups.sort((a, b) => b.length - a.length || rank(a) - rank(b));
  const consensusGroup = groups[0] ?? null;
  const outliers = groups.slice(1).flat();
  return { groups, consensus: consensusGroup, outliers };
}

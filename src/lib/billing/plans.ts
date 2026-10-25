import { db, newId, now } from "@/lib/db";
import type { Workspace } from "@/lib/auth";

export type PlanId = "payg" | "starter" | "growth" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  monthly: number | null; // USD, null = contact sales
  includedPacks: number; // per month
  overagePerPack: number | null; // USD per extra pack on subscription plans
  perPack: number | null; // USD per pack on pay-as-you-go
  seats: number | null;
  api: boolean;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  payg: {
    id: "payg", name: "Per pack", tagline: "For occasional shipments",
    monthly: 0, includedPacks: 0, overagePerPack: null, perPack: 12, seats: 1, api: false,
    features: ["3 free packs to start", "All 36 cross-document checks", "AI extraction of PDFs & scans", "Pre-submission certificate (PDF)"],
  },
  starter: {
    id: "starter", name: "Starter", tagline: "For exporters shipping weekly",
    monthly: 149, includedPacks: 25, overagePerPack: 6, perPack: null, seats: 3, api: false,
    features: ["25 packs / month included", "3 team seats", "Correction emails drafted for you", "Custom tolerances & rules"],
  },
  growth: {
    id: "growth", name: "Growth", tagline: "For forwarders & agencies",
    monthly: 449, includedPacks: 100, overagePerPack: 4, perPack: null, seats: 10, api: true,
    features: ["100 packs / month included", "10 team seats", "REST API & API keys", "Priority extraction queue"],
  },
  enterprise: {
    id: "enterprise", name: "Enterprise", tagline: "For high-volume forwarders",
    monthly: null, includedPacks: 1000, overagePerPack: null, perPack: null, seats: null, api: true,
    features: ["Volume pricing", "SSO & audit export", "TMS / ERP integrations", "Dedicated onboarding"],
  },
};

export function planOf(ws: Pick<Workspace, "plan">): Plan {
  return PLANS[(ws.plan as PlanId) in PLANS ? (ws.plan as PlanId) : "payg"];
}

function periodEnd(start: string): Date {
  const d = new Date(start);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Roll the monthly usage window forward if it has elapsed. */
function currentPeriodStart(ws: Workspace): string {
  let start = ws.period_start;
  while (periodEnd(start) <= new Date()) start = periodEnd(start).toISOString();
  if (start !== ws.period_start) db().prepare("UPDATE workspaces SET period_start = ? WHERE id = ?").run(start, ws.id);
  return start;
}

export interface Usage {
  plan: Plan;
  periodStart: string;
  periodEnd: string;
  used: number;
  included: number;
  includedUsed: number;
  credits: number;
  overage: number;
  canAnalyze: boolean;
  reason: string | null;
}

export function usageFor(ws: Workspace): Usage {
  const plan = planOf(ws);
  const start = currentPeriodStart(ws);
  const rows = db()
    .prepare("SELECT kind, SUM(units) AS n FROM usage_events WHERE workspace_id = ? AND created_at >= ? GROUP BY kind")
    .all(ws.id, start) as { kind: string; n: number }[];
  const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
  const used = n("pack.included") + n("pack.credit") + n("pack.overage");
  const fresh = db().prepare("SELECT pack_credits FROM workspaces WHERE id = ?").get(ws.id) as { pack_credits: number };
  const remainingIncluded = Math.max(0, plan.includedPacks - n("pack.included"));
  const canAnalyze = remainingIncluded > 0 || fresh.pack_credits > 0 || plan.overagePerPack != null || plan.id === "enterprise";
  return {
    plan, periodStart: start, periodEnd: periodEnd(start).toISOString(), used,
    included: plan.includedPacks, includedUsed: n("pack.included"), credits: fresh.pack_credits, overage: n("pack.overage"), canAnalyze,
    reason: canAnalyze ? null : "You have used all your pack credits. Buy more packs or choose a monthly plan.",
  };
}

/**
 * Meter one analysed pack. Order of consumption: plan allowance, then
 * prepaid credits, then metered overage (subscription plans only).
 * Returns false when the workspace cannot pay for another pack.
 */
export function chargePack(ws: Workspace, packId: string): boolean {
  const u = usageFor(ws);
  let kind: string;
  if (u.includedUsed < u.included) kind = "pack.included";
  else if (u.credits > 0) {
    kind = "pack.credit";
    db().prepare("UPDATE workspaces SET pack_credits = pack_credits - 1 WHERE id = ?").run(ws.id);
  } else if (u.plan.overagePerPack != null || u.plan.id === "enterprise") kind = "pack.overage";
  else return false;
  db().prepare("INSERT INTO usage_events (id, workspace_id, pack_id, kind, units, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(newId("use"), ws.id, packId, kind, now());
  return true;
}

export function setPlan(workspaceId: string, plan: PlanId, stripe?: { customerId?: string | null; subscriptionId?: string | null }) {
  db().prepare(
    "UPDATE workspaces SET plan = ?, period_start = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ? WHERE id = ?",
  ).run(plan, now(), stripe?.customerId ?? null, stripe?.subscriptionId ?? null, workspaceId);
}

export function addCredits(workspaceId: string, n: number) {
  db().prepare("UPDATE workspaces SET pack_credits = pack_credits + ? WHERE id = ?").run(n, workspaceId);
}

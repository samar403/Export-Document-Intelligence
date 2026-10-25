import Stripe from "stripe";
import type { Workspace } from "@/lib/auth";
import { addCredits, setPlan, type PlanId } from "./plans";

let stripe: Stripe | null = null;

/** Billing runs in demo mode (instant plan changes) unless Stripe is configured. */
export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function client(): Stripe {
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  return stripe;
}

const PRICE_ENV: Record<"starter" | "growth" | "pack", string> = {
  starter: "STRIPE_PRICE_STARTER",
  growth: "STRIPE_PRICE_PRO",
  pack: "STRIPE_PRICE_PACK",
};

export async function createCheckout(ws: Workspace, item: "starter" | "growth" | "pack", quantity: number, baseUrl: string): Promise<string> {
  const price = process.env[PRICE_ENV[item]];
  if (!price) throw new Error(`Set ${PRICE_ENV[item]} to the Stripe price id for "${item}".`);
  const session = await client().checkout.sessions.create({
    mode: item === "pack" ? "payment" : "subscription",
    line_items: [{ price, quantity: item === "pack" ? quantity : 1 }],
    customer: ws.stripe_customer_id ?? undefined,
    client_reference_id: ws.id,
    metadata: { workspaceId: ws.id, item, quantity: String(quantity) },
    subscription_data: item === "pack" ? undefined : { metadata: { workspaceId: ws.id, plan: item } },
    success_url: `${baseUrl}/app/billing?checkout=success`,
    cancel_url: `${baseUrl}/app/billing?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL.");
  return session.url;
}

export async function createPortal(ws: Workspace, baseUrl: string): Promise<string> {
  if (!ws.stripe_customer_id) throw new Error("No Stripe customer for this workspace yet.");
  const portal = await client().billingPortal.sessions.create({ customer: ws.stripe_customer_id, return_url: `${baseUrl}/app/billing` });
  return portal.url;
}

/** Verify and apply a Stripe webhook. Returns a short description for logs. */
export async function handleWebhook(rawBody: string, signature: string | null): Promise<string> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signature) throw new Error("Webhook secret or signature missing");
  const event = client().webhooks.constructEvent(rawBody, signature, secret);
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const wsId = s.metadata?.workspaceId ?? s.client_reference_id;
      if (!wsId) return "ignored: no workspace";
      const item = s.metadata?.item;
      if (item === "pack") {
        addCredits(wsId, Number(s.metadata?.quantity ?? 1));
        return `credits added to ${wsId}`;
      }
      if (item === "starter" || item === "growth") {
        setPlan(wsId, item as PlanId, {
          customerId: typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null),
          subscriptionId: typeof s.subscription === "string" ? s.subscription : (s.subscription?.id ?? null),
        });
        return `plan ${item} for ${wsId}`;
      }
      return "ignored: unknown item";
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const wsId = sub.metadata?.workspaceId;
      if (wsId) setPlan(wsId, "payg", { subscriptionId: null });
      return `subscription ended for ${wsId}`;
    }
    default:
      return `ignored ${event.type}`;
  }
}

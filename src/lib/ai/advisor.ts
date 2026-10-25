import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiEnabled, AiError, anthropic, effort, FALLBACK, MODEL } from "./client";
import { DOC_TYPE_LABEL, type DocType, type Issue, type PackDocument } from "@/lib/domain/types";
import { fmtMoney } from "@/lib/engine/normalize";

export const OWNERS = ["exporter", "forwarder", "buyer", "broker"] as const;
export type Owner = (typeof OWNERS)[number];

export const OWNER_LABEL: Record<Owner, string> = {
  exporter: "Your documentation team",
  forwarder: "Freight forwarder / carrier",
  buyer: "Buyer",
  broker: "Customs broker",
};

export const AdvicePlanSchema = z.object({
  headline: z.string().describe("One sentence: can this pack be filed, and what is the single biggest risk"),
  summary: z.string().describe("2-4 sentences for the shipment owner, plain language, cite document numbers"),
  steps: z.array(
    z.object({
      owner: z.enum(OWNERS),
      action: z.string().describe("Imperative, specific, names the document and the exact correction"),
      issueIds: z.array(z.string()),
    }),
  ),
  drafts: z.array(
    z.object({
      to: z.enum(OWNERS),
      subject: z.string(),
      body: z.string().describe("Ready-to-send email body, plain text, no placeholders except [Your name]"),
    }),
  ),
});
export type AdvicePlan = z.infer<typeof AdvicePlanSchema> & { source: "claude" | "rules" };

const ADVISOR_SYSTEM = `You are a senior export documentation controller reviewing a shipment's document pack the day before it is filed. A deterministic rules engine has already compared the documents and produced a list of open findings, each with evidence and the document most likely to be wrong. Your job is to turn those findings into action.

- Work only from the findings and document list provided. Do not invent findings, numbers or parties; quote document numbers and values exactly as given.
- Decide who must act on each finding: "exporter" (the user's own team issues the invoice, packing list, certificate of origin and shipping instruction), "forwarder" (B/L drafts, container and vessel data, booking), "buyer" (purchase orders, price or quantity approvals), "broker" (destination customs filings).
- Order steps by what blocks filing first (blockers, then warnings, then advisories). Group findings that share one fix into one step.
- Write one email draft per external party that has something to do (never to "exporter"). Each draft lists every correction that party must make, with the current wrong value and the correct value, and asks for a corrected document by a clear deadline relative to the vessel cut-off. Professional, brief, no filler, sign off with [Your name].
- If there are no blockers or warnings, say the pack is ready and keep steps to advisories only.`;

function ownerFor(docType: DocType | undefined): Owner {
  if (docType === "bill_of_lading") return "forwarder";
  if (docType === "purchase_order") return "buyer";
  return "exporter";
}

/** Deterministic plan used when Claude is not configured (or fails). */
export function rulesAdvice(packName: string, docs: PackDocument[], issues: Issue[], currency: string | null): AdvicePlan {
  const typeOf = (id: string | null) => docs.find((d) => d.id === id)?.extraction.document.docType;
  const labelOf = (id: string | null) => {
    const d = docs.find((x) => x.id === id);
    if (!d) return "the pack";
    const doc = d.extraction.document;
    return `${DOC_TYPE_LABEL[doc.docType]}${doc.docNumber ? ` ${doc.docNumber}` : ""}`;
  };
  const blockers = issues.filter((i) => i.severity === "blocker");
  const warnings = issues.filter((i) => i.severity === "warning");
  const risk = issues.reduce((a, i) => a + (i.valueAtRisk ?? 0), 0);

  const steps = issues.map((i) => ({
    owner: ownerFor(typeOf(i.suspectDocId)),
    action: `${i.suspectDocId ? `On the ${labelOf(i.suspectDocId)}: ` : ""}${i.suggestion}`,
    issueIds: [i.id],
  }));

  const byOwner = new Map<Owner, Issue[]>();
  for (const i of issues) {
    if (i.severity === "advisory") continue;
    const o = ownerFor(typeOf(i.suspectDocId));
    if (o === "exporter") continue;
    byOwner.set(o, [...(byOwner.get(o) ?? []), i]);
  }
  const drafts = [...byOwner.entries()].map(([to, list]) => ({
    to,
    subject: `Corrections needed before filing — ${packName}`,
    body: [
      `Hello,`,
      ``,
      `We have checked the documents for ${packName} against each other and found ${list.length} item${list.length > 1 ? "s" : ""} that must be corrected before we can file:`,
      ``,
      ...list.map((i, n) => {
        const wrong = i.evidence.find((e) => !e.agrees && e.docId === i.suspectDocId);
        const right = i.evidence.find((e) => e.agrees);
        const vals = wrong && right ? ` Currently “${wrong.value ?? "missing"}”; should be “${right.value}”.` : "";
        return `${n + 1}. ${labelOf(i.suspectDocId)} — ${i.title}.${vals}`;
      }),
      ``,
      `Could you please send corrected document${list.length > 1 ? "s" : ""} today, and in any case before the vessel documentation cut-off?`,
      ``,
      `Thank you,`,
      `[Your name]`,
    ].join("\n"),
  }));

  const headline = blockers.length
    ? `Do not file yet — ${blockers.length} blocker${blockers.length > 1 ? "s" : ""} would cause a hold or rejection.`
    : warnings.length
      ? `Fileable after review — ${warnings.length} warning${warnings.length > 1 ? "s" : ""} worth correcting first.`
      : "Cleared to file — the documents agree on every material field.";
  const summary = issues.length
    ? `${issues.length} open finding${issues.length > 1 ? "s" : ""} across ${docs.length} documents${risk ? `, with ${fmtMoney(risk, currency)} of value affected` : ""}. ${blockers[0] ? `Most urgent: ${blockers[0].title}.` : ""}`.trim()
    : `All ${docs.length} documents are consistent. Keep this report with the shipment file.`;
  return { headline, summary, steps, drafts, source: "rules" };
}

export async function adviseOnPack(input: {
  packName: string;
  route: string | null;
  docs: PackDocument[];
  issues: Issue[];
  currency: string | null;
}): Promise<AdvicePlan> {
  const fallback = () => rulesAdvice(input.packName, input.docs, input.issues, input.currency);
  if (!aiEnabled()) return fallback();

  const documents = input.docs.map((d) => ({
    id: d.id,
    type: DOC_TYPE_LABEL[d.extraction.document.docType],
    number: d.extraction.document.docNumber,
    file: d.fileName,
  }));
  const findings = input.issues.map((i) => ({
    id: i.id, severity: i.severity, title: i.title, detail: i.detail, suggestion: i.suggestion,
    suspectDocumentId: i.suspectDocId, valueAtRisk: i.valueAtRisk,
    evidence: i.evidence.map((e) => ({ documentId: e.docId, value: e.value, where: e.location, agreesWithConsensus: e.agrees })),
  }));

  try {
    const response = await anthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      thinking: { type: "adaptive" },
      output_config: { effort: effort("PLIMSOLL_ADVISOR_EFFORT", "medium"), format: betaZodOutputFormat(AdvicePlanSchema) },
      system: ADVISOR_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({ shipment: input.packName, route: input.route, currency: input.currency, documents, openFindings: findings }, null, 2),
        },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) throw new AiError("No advice returned", true);
    return { ...response.parsed_output, source: "claude" };
  } catch {
    return fallback();
  }
}

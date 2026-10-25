import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AiError, anthropic, effort, FALLBACK, MODEL } from "@/lib/ai/client";
import type { ExtractionResult } from "@/lib/domain/types";
import { documentFromPayload, ExtractionSchema } from "./schema";

/**
 * Extraction prompt. The model's only job is faithful transcription into the
 * schema — the reconciliation engine does all comparison and judgement, so
 * the prompt forbids "fixing" anything. A corrected typo here would hide the
 * very discrepancy the customer is paying us to find.
 */
export const EXTRACTION_SYSTEM = `You are the document-reading stage of Plimsoll, a pre-submission checker for export shipments. Exporters, freight forwarders and shipping agents upload commercial invoices, packing lists, purchase orders, bills of lading, certificates of origin and shipping instructions; a separate rules engine then compares them field by field and flags every discrepancy before the pack is filed with customs, a bank or a carrier.

Your output is the evidence for that comparison, so transcribe — never reconcile.

Fidelity rules
- Copy values exactly as printed: party names, addresses, descriptions, SKUs, HS codes (keep the dots), container numbers, reference numbers. Do not fix typos, expand abbreviations, recompute amounts or fill a field from another document. If a line amount is arithmetically wrong, report the printed amount.
- If a field is not printed on the document, return null (or an empty list). Do not infer a consignee from a notify party, an origin from an address, or a currency from a country.
- Report numbers as plain numbers without thousands separators, reading the decimal convention the document uses ("1.234,50" is 1234.5).
- Dates as YYYY-MM-DD. Assume day-first for ambiguous numeric dates unless the document is clearly US-formatted, and say so in warnings.
- Currency as the ISO 4217 code ("US$" → "USD").
- Weights in kilograms. If the document states pounds or tonnes, convert and add a warning naming the conversion.

Classification
- docType is what the document is, judged by its title and content, not by its file name. A proforma invoice is a commercial_invoice with a warning. A sea waybill or house B/L is a bill_of_lading. Booking confirmations and anything else are "other".
- docNumber is this document's own number. poNumber and invoiceNumber are references to other documents. On a purchase order, the PO number goes in docNumber.
- On a purchase order, shipper is the supplier/seller and consignee is the buyer or ship-to party.

Line items
- One entry per printed line, in printed order, merging tables that continue across pages. Skip subtotal, freight, insurance and discount rows (mention them in warnings with their amounts).
- quantity is the commercial quantity of the line with its unit (PCS, KG, SETS…); packages is the carton/package count for that line when a separate column gives it.
- If a description wraps over several lines, join it into one string.

Totals: copy the printed totals only. Leave a total null if the document does not print it — do not sum lines yourself.

confidence: 1.0 for a clean digital document read completely; lower it for poor scans, handwriting, cropped pages or fields you were unsure of, and explain each doubt in warnings.`;

type Source = { kind: "pdf" | "image"; mediaType: string; data: Buffer } | { kind: "text"; text: string };

function contentFor(src: Source): Anthropic.Beta.BetaContentBlockParam {
  if (src.kind === "pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: src.data.toString("base64") } };
  }
  if (src.kind === "text") return { type: "document", source: { type: "text", media_type: "text/plain", data: src.text } };
  return {
    type: "image",
    source: { type: "base64", media_type: src.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: src.data.toString("base64") },
  };
}

export async function extractWithClaude(src: Source, fileName: string): Promise<ExtractionResult> {
  const response = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 20000,
    ...FALLBACK,
    thinking: { type: "adaptive" },
    output_config: {
      effort: effort("PLIMSOLL_EXTRACTION_EFFORT", "medium"),
      format: betaZodOutputFormat(ExtractionSchema),
    },
    system: [{ type: "text", text: EXTRACTION_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          contentFor(src),
          { type: "text", text: `File name: ${fileName}\n\nExtract this trade document into the schema.` },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new AiError("Claude declined to read this document. Try the layout parser or enter the fields manually.", false);
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiError("The document is too long to extract in one pass. Split it into smaller files.", false);
  }
  const out = response.parsed_output;
  if (!out) throw new AiError("Claude returned an unreadable extraction.", true);

  const { confidence, warnings, ...payload } = out;
  return {
    document: documentFromPayload(payload),
    method: "claude",
    confidence: Math.max(0, Math.min(1, confidence)),
    warnings,
  };
}

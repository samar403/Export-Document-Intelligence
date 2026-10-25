import { z } from "zod";
import { DOC_TYPES, emptyDocument, emptyLine, type ExtractedDocument } from "@/lib/domain/types";

/**
 * The extraction contract shared by Claude (as a structured-output schema)
 * and JSON imports. Every field is present and nullable so the model is never
 * forced to invent a value to satisfy the schema.
 */

const s = () => z.string().nullable();
const n = () => z.number().nullable();

export const PartySchema = z.object({
  name: s().describe("Legal entity name exactly as printed"),
  address: s().describe("Street address, city and postcode, without the country"),
  country: s().describe("Country as printed"),
  taxId: s().describe("VAT / EIN / IEC / EORI / TRN or similar, if printed"),
});

export const LineSchema = z.object({
  lineNo: n(),
  sku: s().describe("Item / article / style code"),
  description: s().describe("Goods description verbatim, including size, material and model"),
  hsCode: s().describe("HS / HTS tariff code exactly as printed, keep dots"),
  quantity: n(),
  unit: s().describe("Unit of measure as printed, e.g. PCS, KG, SETS, CTNS"),
  unitPrice: n(),
  amount: n().describe("Line amount / extended value as printed (do not recompute)"),
  netWeightKg: n(),
  grossWeightKg: n(),
  packages: n().describe("Number of packages / cartons for this line"),
  countryOfOrigin: s(),
});

export const TotalsSchema = z.object({
  quantity: n().describe("Total quantity as printed"),
  amount: n().describe("Total invoice / order value as printed"),
  netWeightKg: n(),
  grossWeightKg: n(),
  packages: n(),
  volumeCbm: n(),
});

export const ExtractionSchema = z.object({
  docType: z.enum(DOC_TYPES),
  docNumber: s().describe("This document's own number (invoice no. on an invoice, B/L no. on a B/L, PO no. on a PO)"),
  docDate: s().describe("Issue date as YYYY-MM-DD"),
  currency: s().describe("ISO 4217 code, e.g. USD"),
  incoterm: s().describe("Three-letter Incoterm as printed, e.g. FOB, CIF (keep non-standard terms like C&F verbatim)"),
  incotermPlace: s().describe("Named place after the Incoterm"),
  poNumber: s().describe("Purchase-order number referenced by this document"),
  invoiceNumber: s().describe("Commercial-invoice number referenced by this document (not on the invoice itself)"),
  shipper: PartySchema.describe("Shipper / exporter / seller / supplier"),
  consignee: PartySchema.describe("Consignee / buyer / ship-to. For a PO, the buyer or ship-to party"),
  notifyParty: PartySchema,
  portOfLoading: s(),
  portOfDischarge: s(),
  vesselVoyage: s(),
  containerNumbers: z.array(z.string()).describe("Container numbers, 4 letters + 7 digits, without seal numbers"),
  countryOfOrigin: s().describe("Country of origin of the goods for the whole document"),
  paymentTerms: s(),
  lineItems: z.array(LineSchema),
  totals: TotalsSchema,
  confidence: z.number().describe("0 to 1: how legible and complete the document was"),
  warnings: z.array(z.string()).describe("Anything illegible, ambiguous, converted (e.g. lbs to kg) or contradictory"),
});

export type ExtractionPayload = z.infer<typeof ExtractionSchema>;

export function documentFromPayload(p: Partial<ExtractionPayload>): ExtractedDocument {
  const base = emptyDocument(p.docType ?? "other");
  const party = (x: Partial<ExtractionPayload["shipper"]> | undefined) => ({ ...base.shipper, ...(x ?? {}) });
  return {
    ...base,
    docType: p.docType ?? "other",
    docNumber: p.docNumber ?? null,
    docDate: p.docDate ?? null,
    currency: p.currency ?? null,
    incoterm: p.incoterm ?? null,
    incotermPlace: p.incotermPlace ?? null,
    poNumber: p.poNumber ?? null,
    invoiceNumber: p.invoiceNumber ?? null,
    shipper: party(p.shipper),
    consignee: party(p.consignee),
    notifyParty: party(p.notifyParty),
    portOfLoading: p.portOfLoading ?? null,
    portOfDischarge: p.portOfDischarge ?? null,
    vesselVoyage: p.vesselVoyage ?? null,
    containerNumbers: p.containerNumbers ?? [],
    countryOfOrigin: p.countryOfOrigin ?? null,
    paymentTerms: p.paymentTerms ?? null,
    lineItems: (p.lineItems ?? []).map((l) => ({ ...emptyLine(), ...l })),
    totals: { ...base.totals, ...(p.totals ?? {}) },
  };
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Lenient import of user-supplied JSON: unknown keys ignored, wrong types become null. */
export function parseJsonDocument(raw: unknown): ExtractedDocument {
  const r = obj(raw && typeof raw === "object" && "document" in (raw as Json) ? (raw as Json).document : raw);
  if (Object.keys(r).length === 0) throw new Error("JSON file is not a document object.");
  const docType = DOC_TYPES.includes(r.docType as (typeof DOC_TYPES)[number]) ? (r.docType as ExtractionPayload["docType"]) : "other";
  const party = (v: unknown) => {
    const p = obj(v);
    return { name: str(p.name), address: str(p.address), country: str(p.country), taxId: str(p.taxId) };
  };
  const t = obj(r.totals);
  return documentFromPayload({
    docType,
    docNumber: str(r.docNumber), docDate: str(r.docDate), currency: str(r.currency), incoterm: str(r.incoterm),
    incotermPlace: str(r.incotermPlace), poNumber: str(r.poNumber), invoiceNumber: str(r.invoiceNumber),
    shipper: party(r.shipper), consignee: party(r.consignee), notifyParty: party(r.notifyParty),
    portOfLoading: str(r.portOfLoading), portOfDischarge: str(r.portOfDischarge), vesselVoyage: str(r.vesselVoyage),
    containerNumbers: Array.isArray(r.containerNumbers) ? r.containerNumbers.map(str).filter((x): x is string => !!x) : [],
    countryOfOrigin: str(r.countryOfOrigin), paymentTerms: str(r.paymentTerms),
    lineItems: (Array.isArray(r.lineItems) ? r.lineItems : []).map((x) => {
      const l = obj(x);
      return {
        lineNo: num(l.lineNo), sku: str(l.sku), description: str(l.description), hsCode: str(l.hsCode), quantity: num(l.quantity),
        unit: str(l.unit), unitPrice: num(l.unitPrice), amount: num(l.amount), netWeightKg: num(l.netWeightKg),
        grossWeightKg: num(l.grossWeightKg), packages: num(l.packages), countryOfOrigin: str(l.countryOfOrigin),
      };
    }),
    totals: {
      quantity: num(t.quantity), amount: num(t.amount), netWeightKg: num(t.netWeightKg), grossWeightKg: num(t.grossWeightKg),
      packages: num(t.packages), volumeCbm: num(t.volumeCbm),
    },
  });
}

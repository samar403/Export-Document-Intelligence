/**
 * Canonical domain model. Every uploaded document — whatever its format or
 * however it was extracted — is normalised into an `ExtractedDocument` before
 * the reconciliation engine sees it. The engine never touches raw files.
 */

export const DOC_TYPES = [
  "commercial_invoice",
  "packing_list",
  "purchase_order",
  "bill_of_lading",
  "certificate_of_origin",
  "shipping_instruction",
  "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  commercial_invoice: "Commercial Invoice",
  packing_list: "Packing List",
  purchase_order: "Purchase Order",
  bill_of_lading: "Bill of Lading",
  certificate_of_origin: "Certificate of Origin",
  shipping_instruction: "Shipping Instruction",
  other: "Other",
};

export const DOC_TYPE_SHORT: Record<DocType, string> = {
  commercial_invoice: "INV",
  packing_list: "PL",
  purchase_order: "PO",
  bill_of_lading: "B/L",
  certificate_of_origin: "COO",
  shipping_instruction: "SI",
  other: "DOC",
};

export interface Party {
  name: string | null;
  address: string | null;
  country: string | null;
  taxId: string | null;
}

export interface LineItem {
  lineNo: number | null;
  sku: string | null;
  description: string | null;
  hsCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  packages: number | null;
  countryOfOrigin: string | null;
}

export interface DocumentTotals {
  quantity: number | null;
  amount: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  packages: number | null;
  volumeCbm: number | null;
}

export interface ExtractedDocument {
  docType: DocType;
  docNumber: string | null;
  docDate: string | null; // ISO yyyy-mm-dd
  currency: string | null; // ISO 4217
  incoterm: string | null; // e.g. FOB
  incotermPlace: string | null;
  poNumber: string | null; // referenced PO
  invoiceNumber: string | null; // referenced invoice (on PL / BL)
  shipper: Party;
  consignee: Party;
  notifyParty: Party;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  vesselVoyage: string | null;
  containerNumbers: string[];
  countryOfOrigin: string | null;
  paymentTerms: string | null;
  lineItems: LineItem[];
  totals: DocumentTotals;
}

export type ExtractionMethod = "claude" | "layout-parser" | "structured" | "manual" | "sample";

export interface ExtractionResult {
  document: ExtractedDocument;
  method: ExtractionMethod;
  /** 0..1 — how much of the document we believe we read correctly. */
  confidence: number;
  warnings: string[];
}

// ---------------------------------------------------------------- Issues ---

export type Severity = "blocker" | "warning" | "advisory";

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  blocker: 18,
  warning: 6,
  advisory: 1.5,
};

export type IssueCategory =
  | "quantity"
  | "description"
  | "value"
  | "party"
  | "reference"
  | "logistics"
  | "compliance"
  | "arithmetic";

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  quantity: "Quantity",
  description: "Description",
  value: "Value",
  party: "Parties",
  reference: "References",
  logistics: "Logistics",
  compliance: "Compliance",
  arithmetic: "Arithmetic",
};

/** One document's reading of a disputed value. */
export interface Evidence {
  docId: string;
  value: string | null;
  /** Human pointer such as "Line 3 · Qty" or "Consignee". */
  location: string;
  /** True when this reading is the consensus / authoritative one. */
  agrees: boolean;
}

export type IssueStatus = "open" | "resolved" | "accepted";

export interface Issue {
  id: string; // deterministic: ruleId + subject
  ruleId: string;
  severity: Severity;
  category: IssueCategory;
  title: string;
  detail: string;
  /** What to do about it, in plain language. */
  suggestion: string;
  /** The field thread this issue belongs to (for the Loom). */
  field: string;
  evidence: Evidence[];
  /** Monetary exposure in pack currency, when computable. */
  valueAtRisk: number | null;
  /** Document most likely to be wrong (consensus outlier), if determinable. */
  suspectDocId: string | null;
}

// --------------------------------------------------------------- Results ---

export interface PackDocument {
  id: string;
  fileName: string;
  extraction: ExtractionResult;
}

export type ThreadCellState = "agree" | "conflict" | "missing" | "na";

/** A row in the Loom: one field read across every document in the pack. */
export interface Thread {
  field: string;
  label: string;
  group: "parties" | "references" | "commercial" | "logistics" | "lines";
  cells: { docId: string; value: string | null; state: ThreadCellState }[];
  consensus: string | null;
  issueIds: string[];
}

export interface LineMatch {
  key: string;
  label: string;
  /** docId -> index into that document's lineItems */
  members: Record<string, number>;
  /** How confident the matcher is that these lines are the same goods. */
  matchScore: number;
}

export type Verdict = "cleared" | "review" | "hold";

export interface ReconciliationReport {
  score: number; // 0..100
  verdict: Verdict;
  currency: string | null;
  issues: Issue[];
  threads: Thread[];
  lineMatches: LineMatch[];
  valueAtRisk: number;
  stats: {
    documents: number;
    fieldsCompared: number;
    linesCompared: number;
    blockers: number;
    warnings: number;
    advisories: number;
  };
  generatedAt: string;
}

export interface RuleSettings {
  /** Relative tolerance for money comparisons (0.005 = 0.5%). */
  valueTolerancePct: number;
  /** Relative tolerance for weight comparisons. */
  weightTolerancePct: number;
  /** 0..1 description similarity under which we flag drift. */
  descriptionSimilarity: number;
  /** Treat PO lines missing from the invoice as partial shipment (advisory) rather than a warning. */
  allowPartialShipments: boolean;
  /** Rule ids switched off by the workspace. */
  disabledRules: string[];
}

export const DEFAULT_RULE_SETTINGS: RuleSettings = {
  valueTolerancePct: 0.005,
  weightTolerancePct: 0.02,
  descriptionSimilarity: 0.55,
  allowPartialShipments: true,
  disabledRules: [],
};

export function emptyParty(): Party {
  return { name: null, address: null, country: null, taxId: null };
}

export function emptyTotals(): DocumentTotals {
  return { quantity: null, amount: null, netWeightKg: null, grossWeightKg: null, packages: null, volumeCbm: null };
}

export function emptyDocument(docType: DocType = "other"): ExtractedDocument {
  return {
    docType,
    docNumber: null,
    docDate: null,
    currency: null,
    incoterm: null,
    incotermPlace: null,
    poNumber: null,
    invoiceNumber: null,
    shipper: emptyParty(),
    consignee: emptyParty(),
    notifyParty: emptyParty(),
    portOfLoading: null,
    portOfDischarge: null,
    vesselVoyage: null,
    containerNumbers: [],
    countryOfOrigin: null,
    paymentTerms: null,
    lineItems: [],
    totals: emptyTotals(),
  };
}

export function emptyLine(): LineItem {
  return {
    lineNo: null,
    sku: null,
    description: null,
    hsCode: null,
    quantity: null,
    unit: null,
    unitPrice: null,
    amount: null,
    netWeightKg: null,
    grossWeightKg: null,
    packages: null,
    countryOfOrigin: null,
  };
}

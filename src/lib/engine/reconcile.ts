import {
  DOC_TYPE_LABEL,
  SEVERITY_WEIGHT,
  type DocType,
  type Evidence,
  type ExtractedDocument,
  type Issue,
  type IssueCategory,
  type LineItem,
  type PackDocument,
  type ReconciliationReport,
  type RuleSettings,
  type Severity,
  type Thread,
  type ThreadCellState,
  DEFAULT_RULE_SETTINGS,
} from "@/lib/domain/types";
import { consensus, type Reading } from "./consensus";
import { matchLines } from "./match";
import {
  containerCheck,
  descriptionSimilarity,
  fmtMoney,
  fmtNumber,
  incotermStatus,
  isCountryWord,
  isValidHs,
  normCompany,
  normCountry,
  normCurrency,
  normHs,
  normIncoterm,
  normRef,
  normText,
  parseNumber,
  round,
  sameAddress,
  sameCompany,
  similarity,
  toBaseQuantity,
  tokenOverlap,
  unitsCompatible,
  withinTolerance,
} from "./normalize";
import { RULE_MAP } from "./rules";

const SHIPPING_DOCS: DocType[] = ["commercial_invoice", "packing_list", "certificate_of_origin", "shipping_instruction", "bill_of_lading"];

/** UN/LOCODEs for the busiest ports so "DEHAM" and "Hamburg" compare equal. */
const PORT_CODES: Record<string, string> = {
  CNSHA: "shanghai", CNNGB: "ningbo", CNSZX: "shenzhen", CNYTN: "yantian", CNQIN: "qingdao", CNTAO: "qingdao",
  CNXMN: "xiamen", CNTSN: "tianjin", CNCAN: "guangzhou", HKHKG: "hong kong", SGSIN: "singapore", KRPUS: "busan",
  JPTYO: "tokyo", JPYOK: "yokohama", TWKHH: "kaohsiung", VNSGN: "ho chi minh", VNHPH: "haiphong", VNCMT: "cai mep",
  THLCH: "laem chabang", MYPKG: "port klang", MYTPP: "tanjung pelepas", IDJKT: "jakarta", INNSA: "nhava sheva",
  INMUN: "mundra", INMAA: "chennai", INBOM: "mumbai", LKCMB: "colombo", BDCGP: "chittagong", PKKHI: "karachi",
  AEJEA: "jebel ali", AEDXB: "dubai", SAJED: "jeddah", TRIST: "istanbul", TRMER: "mersin", EGPSD: "port said",
  DEHAM: "hamburg", DEBRV: "bremerhaven", NLRTM: "rotterdam", BEANR: "antwerp", FRLEH: "le havre", GBFXT: "felixstowe",
  GBSOU: "southampton", GBLGP: "london gateway", ESVLC: "valencia", ESALG: "algeciras", ESBCN: "barcelona", ITGOA: "genoa",
  GRPIR: "piraeus", PLGDN: "gdansk", SEGOT: "gothenburg", DKAAR: "aarhus", USLAX: "los angeles", USLGB: "long beach",
  USNYC: "new york", USSAV: "savannah", USHOU: "houston", USSEA: "seattle", USOAK: "oakland", USCHS: "charleston",
  CAVAN: "vancouver", CAMTR: "montreal", MXZLO: "manzanillo", BRSSZ: "santos", AUSYD: "sydney", AUMEL: "melbourne",
  ZADUR: "durban", KEMBA: "mombasa", VNCLI: "cat lai", INCOK: "cochin",
};

function portName(s: string): string {
  const compact = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (PORT_CODES[compact]) return PORT_CODES[compact];
  // A UN/LOCODE we know wins outright: "Hamburg (DEHAM)", "SEGOT Gothenburg".
  for (const m of s.toUpperCase().matchAll(/\b([A-Z]{2})\s?([A-Z0-9]{3})\b/g)) {
    const code = m[1] + m[2];
    if (PORT_CODES[code]) return PORT_CODES[code];
  }
  // Otherwise drop unknown LOCODE-looking tokens and country names, keep the place.
  const words = s
    .replace(/\b[A-Z]{5}\b/g, (tok) => (s.trim() === tok ? tok : " "))
    .split(/[,()/]+/)
    .map((part) => part.trim())
    .filter((part) => part && !isCountryWord(part));
  return normText(words.join(" ").replace(/\bport( of)?\b/gi, ""));
}

function samePort(a: string, b: string): boolean {
  const pa = portName(a);
  const pb = portName(b);
  if (pa === pb) return true;
  return tokenOverlap(pa, pb) >= 1 || similarity(pa, pb) >= 0.85;
}

/** "To order" / "To the order of <bank>" consignees are legitimate under letters of credit. */
function isToOrder(s: string): boolean {
  return /^\s*to\s+(the\s+)?order\b/i.test(s);
}

function sameNumber(rel: number) {
  return (a: string, b: string) => {
    const na = parseNumber(a);
    const nb = parseNumber(b);
    if (na == null || nb == null) return a === b;
    return withinTolerance(na, nb, rel);
  };
}

// ----------------------------------------------------------- Header specs ---

interface HeaderSpec {
  ruleId: string;
  field: string;
  label: string;
  group: Thread["group"];
  /** Document types expected to carry the field (used for "missing" cells). */
  carriers: DocType[];
  /** Tie-break order when two readings disagree 1:1. */
  authority: DocType[];
  read(doc: ExtractedDocument): string | null;
  equal(a: string, b: string, s: RuleSettings): boolean;
  display?(v: string, doc: ExtractedDocument): string;
  /** Document types on which an absent value is itself an issue. */
  requiredOn?: DocType[];
  suggestion: string;
  /** Optional override of severity based on who disagrees. */
  severityFor?(outlierTypes: DocType[], base: Severity): Severity;
  category?: IssueCategory;
  money?: boolean;
}

const HEADER_SPECS: HeaderSpec[] = [
  {
    ruleId: "party.consignee_name", field: "consignee.name", label: "Consignee", group: "parties",
    carriers: ["commercial_invoice", "packing_list", "bill_of_lading", "certificate_of_origin", "shipping_instruction", "purchase_order"],
    authority: ["bill_of_lading", "commercial_invoice", "shipping_instruction", "packing_list", "certificate_of_origin", "purchase_order"],
    read: (d) => d.consignee.name,
    equal: (a, b) => isToOrder(a) || isToOrder(b) || sameCompany(a, b) >= 0.86,
    requiredOn: ["commercial_invoice", "bill_of_lading", "packing_list"],
    suggestion: "Confirm the legal entity with the buyer, then amend the outlier document. If the B/L is wrong, request a corrected draft from the carrier before it is issued.",
    severityFor: (types, base) => (types.every((t) => t === "purchase_order") ? "warning" : base),
  },
  {
    ruleId: "party.consignee_address", field: "consignee.address", label: "Consignee address", group: "parties",
    carriers: ["commercial_invoice", "packing_list", "bill_of_lading", "certificate_of_origin"],
    authority: ["bill_of_lading", "commercial_invoice", "packing_list", "certificate_of_origin", "shipping_instruction", "purchase_order"],
    read: (d) => (isToOrder(d.consignee.name ?? "") ? null : d.consignee.address),
    equal: (a, b) => sameAddress(a, b) >= 0.8,
    suggestion: "Align the consignee address on every document to the one on the B/L (street number and postcode must match exactly).",
    severityFor: (types, base) => (types.every((t) => t === "purchase_order") ? "advisory" : base),
  },
  {
    ruleId: "party.consignee_address", field: "consignee.country", label: "Destination country", group: "parties",
    carriers: [], authority: ["bill_of_lading", "commercial_invoice"],
    read: (d) => normCountry(d.consignee.country),
    equal: (a, b) => a === b,
    suggestion: "The consignee country must be the same everywhere — check whether a template from another buyer was reused.",
    severityFor: () => "blocker",
  },
  {
    ruleId: "party.shipper_name", field: "shipper.name", label: "Shipper / exporter", group: "parties",
    carriers: ["commercial_invoice", "packing_list", "bill_of_lading", "certificate_of_origin", "shipping_instruction"],
    authority: ["commercial_invoice", "bill_of_lading", "packing_list", "certificate_of_origin", "shipping_instruction", "purchase_order"],
    read: (d) => d.shipper.name,
    equal: (a, b) => sameCompany(a, b) >= 0.86,
    requiredOn: ["commercial_invoice", "packing_list", "bill_of_lading"],
    suggestion: "Use the exporter-of-record name exactly as registered for export (EORI / IEC / EIN) on every document.",
    severityFor: (types, base) => (types.every((t) => t === "purchase_order") ? "advisory" : base),
  },
  {
    ruleId: "party.shipper_address", field: "shipper.address", label: "Shipper address", group: "parties",
    carriers: ["commercial_invoice", "packing_list", "bill_of_lading"],
    authority: ["commercial_invoice", "bill_of_lading", "packing_list"],
    read: (d) => d.shipper.address,
    equal: (a, b) => sameAddress(a, b) >= 0.8,
    suggestion: "Harmonise the shipper address — banks examining under UCP 600 may still raise a discrepancy.",
  },
  {
    ruleId: "party.notify", field: "notifyParty.name", label: "Notify party", group: "parties",
    carriers: ["bill_of_lading", "shipping_instruction"],
    authority: ["shipping_instruction", "bill_of_lading", "commercial_invoice"],
    read: (d) => d.notifyParty.name,
    equal: (a, b) => sameCompany(a, b) >= 0.86 || normCompany(a).includes("same as consignee") || normCompany(b).includes("same as consignee"),
    suggestion: "Make sure the arrival notice goes to the buyer's customs broker named in the shipping instruction.",
  },
  {
    ruleId: "ref.po_number", field: "poNumber", label: "PO number", group: "references",
    carriers: ["commercial_invoice", "packing_list", "purchase_order"],
    authority: ["purchase_order", "commercial_invoice", "packing_list"],
    read: (d) => (d.docType === "purchase_order" ? (d.docNumber ?? d.poNumber) : d.poNumber),
    equal: (a, b) => normRef(a) === normRef(b),
    requiredOn: ["commercial_invoice"],
    suggestion: "Quote the buyer's PO number exactly as issued — buyers' AP systems match on it character for character.",
  },
  {
    ruleId: "ref.invoice_number", field: "invoiceNumber", label: "Invoice number", group: "references",
    carriers: ["commercial_invoice", "packing_list", "certificate_of_origin"],
    authority: ["commercial_invoice", "packing_list", "certificate_of_origin", "bill_of_lading"],
    read: (d) => (d.docType === "commercial_invoice" ? (d.docNumber ?? d.invoiceNumber) : d.invoiceNumber),
    equal: (a, b) => normRef(a) === normRef(b),
    requiredOn: ["commercial_invoice", "packing_list"],
    suggestion: "Reference the final invoice number on the packing list and certificate of origin — a proforma number is not accepted.",
  },
  {
    ruleId: "commercial.currency", field: "currency", label: "Currency", group: "commercial",
    carriers: ["commercial_invoice", "purchase_order"], authority: ["purchase_order", "commercial_invoice"],
    read: (d) => normCurrency(d.currency),
    equal: (a, b) => a === b,
    requiredOn: ["commercial_invoice"],
    suggestion: "Invoice in the currency agreed on the PO, or attach the buyer's written approval of the change.",
  },
  {
    ruleId: "commercial.incoterm", field: "incoterm", label: "Incoterm", group: "commercial",
    carriers: ["commercial_invoice", "purchase_order"], authority: ["purchase_order", "commercial_invoice", "shipping_instruction"],
    read: (d) => {
      const t = normIncoterm(d.incoterm);
      return t ? [t, d.incotermPlace].filter(Boolean).join(" ") : null;
    },
    equal: (a, b) => a.slice(0, 3) === b.slice(0, 3) && (a.length <= 4 || b.length <= 4 || samePort(a.slice(4), b.slice(4))),
    requiredOn: ["commercial_invoice"],
    suggestion: "Use the Incoterm and named place from the PO. Changing FOB to CIF (or similar) changes the customs value.",
  },
  {
    ruleId: "commercial.total_quantity", field: "totals.quantity", label: "Total quantity", group: "commercial",
    carriers: ["commercial_invoice", "packing_list"], authority: ["packing_list", "commercial_invoice"],
    read: (d) => (d.docType === "purchase_order" ? null : d.totals.quantity?.toString() ?? null),
    equal: sameNumber(0),
    display: (v) => fmtNumber(parseNumber(v)),
    suggestion: "Recount: the packing list is what was physically loaded, so correct the invoice to match it (or re-pack).",
  },
  {
    ruleId: "logistics.packages", field: "totals.packages", label: "Packages", group: "logistics",
    carriers: ["packing_list", "bill_of_lading"], authority: ["packing_list", "bill_of_lading", "commercial_invoice"],
    read: (d) => d.totals.packages?.toString() ?? null,
    equal: sameNumber(0),
    display: (v) => fmtNumber(parseNumber(v)),
    requiredOn: ["packing_list", "bill_of_lading"],
    suggestion: "Correct the package count on the B/L draft to the packing list figure — it is what the carrier signs for.",
  },
  {
    ruleId: "logistics.gross_weight", field: "totals.grossWeightKg", label: "Gross weight (kg)", group: "logistics",
    carriers: ["packing_list", "bill_of_lading"], authority: ["packing_list", "bill_of_lading", "commercial_invoice"],
    read: (d) => d.totals.grossWeightKg?.toString() ?? null,
    equal: (a, b, s) => sameNumber(s.weightTolerancePct)(a, b),
    display: (v) => `${fmtNumber(parseNumber(v), 2)} kg`,
    requiredOn: ["packing_list", "bill_of_lading"],
    suggestion: "Re-weigh or correct the outlier. The B/L gross weight must agree with the VGM submitted to the carrier.",
  },
  {
    ruleId: "logistics.net_weight", field: "totals.netWeightKg", label: "Net weight (kg)", group: "logistics",
    carriers: ["packing_list"], authority: ["packing_list", "commercial_invoice", "certificate_of_origin"],
    read: (d) => d.totals.netWeightKg?.toString() ?? null,
    equal: (a, b, s) => sameNumber(s.weightTolerancePct)(a, b),
    display: (v) => `${fmtNumber(parseNumber(v), 2)} kg`,
    suggestion: "Align the net weight with the packing list.",
  },
  {
    ruleId: "logistics.port_loading", field: "portOfLoading", label: "Port of loading", group: "logistics",
    carriers: ["bill_of_lading", "commercial_invoice"], authority: ["bill_of_lading", "shipping_instruction", "commercial_invoice", "packing_list"],
    read: (d) => d.portOfLoading,
    equal: (a, b) => samePort(a, b),
    suggestion: "Use the port of loading on the carrier's booking confirmation on every document.",
  },
  {
    ruleId: "logistics.port_discharge", field: "portOfDischarge", label: "Port of discharge", group: "logistics",
    carriers: ["bill_of_lading", "commercial_invoice"], authority: ["bill_of_lading", "shipping_instruction", "commercial_invoice", "packing_list"],
    read: (d) => d.portOfDischarge,
    equal: (a, b) => samePort(a, b),
    suggestion: "Confirm the discharge port with the booking; update the invoice and packing list if the routing changed.",
  },
  {
    ruleId: "logistics.vessel", field: "vesselVoyage", label: "Vessel / voyage", group: "logistics",
    carriers: ["bill_of_lading"], authority: ["bill_of_lading", "shipping_instruction", "packing_list", "commercial_invoice"],
    read: (d) => d.vesselVoyage,
    equal: (a, b) => tokenOverlap(a, b) >= 0.8 || similarity(a, b) >= 0.85,
    suggestion: "If the booking was rolled, update the vessel on the invoice and packing list to match the B/L.",
  },
  {
    ruleId: "logistics.containers", field: "containerNumbers", label: "Containers", group: "logistics",
    carriers: ["bill_of_lading"], authority: ["bill_of_lading", "packing_list", "shipping_instruction", "commercial_invoice"],
    read: (d) => (d.containerNumbers.length ? d.containerNumbers.map((c) => containerCheck(c).normalized).sort().join(", ") : null),
    equal: (a, b) => a === b,
    suggestion: "Copy container and seal numbers from the gate-in receipt rather than retyping them.",
  },
  {
    ruleId: "compliance.origin", field: "countryOfOrigin", label: "Country of origin", group: "commercial",
    carriers: ["commercial_invoice", "certificate_of_origin"], authority: ["certificate_of_origin", "commercial_invoice", "packing_list"],
    read: (d) => normCountry(d.countryOfOrigin),
    equal: (a, b) => a === b,
    requiredOn: ["commercial_invoice"],
    suggestion: "Origin must match the certificate of origin. If goods have mixed origin, declare origin per line.",
  },
];

// ----------------------------------------------------------------- Engine ---

interface Ctx {
  docs: PackDocument[];
  byId: Map<string, PackDocument>;
  settings: RuleSettings;
  issues: Issue[];
  threads: Thread[];
  currency: string | null;
  label(docId: string): string;
}

function docLabeler(docs: PackDocument[]) {
  const counts = new Map<DocType, number>();
  for (const d of docs) counts.set(d.extraction.document.docType, (counts.get(d.extraction.document.docType) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const d of docs) {
    const doc = d.extraction.document;
    const base = DOC_TYPE_LABEL[doc.docType];
    labels.set(d.id, (counts.get(doc.docType) ?? 0) > 1 ? `${base} ${doc.docNumber ?? d.fileName}` : base);
  }
  return (id: string) => labels.get(id) ?? id;
}

function listLabels(ctx: Ctx, ids: string[]): string {
  const names = [...new Set(ids.map((i) => ctx.label(i)))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const SEVERITY_ORDER: Severity[] = ["blocker", "warning", "advisory"];
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function push(ctx: Ctx, issue: Omit<Issue, "category"> & { category?: IssueCategory }) {
  const rule = RULE_MAP[issue.ruleId];
  if (ctx.settings.disabledRules.includes(issue.ruleId)) return;
  if (ctx.issues.some((i) => i.id === issue.id)) return;
  ctx.issues.push({ ...issue, category: issue.category ?? rule?.category ?? "compliance" });
}

function quote(v: string | null): string {
  return v == null ? "nothing" : `“${v}”`;
}

function checkHeaders(ctx: Ctx) {
  for (const spec of HEADER_SPECS) {
    const readings: Reading<string>[] = [];
    for (const d of ctx.docs) {
      const v = spec.read(d.extraction.document);
      if (v != null && String(v).trim() !== "") readings.push({ docId: d.id, docType: d.extraction.document.docType, value: String(v).trim() });
    }
    const thread: Thread = {
      field: spec.field, label: spec.label, group: spec.group,
      cells: [], consensus: null, issueIds: [],
    };
    const result = consensus(readings, (a, b) => spec.equal(a, b, ctx.settings), spec.authority);
    const consensusIds = new Set(result.consensus?.map((r) => r.docId) ?? []);
    const show = (v: string, docId: string) => (spec.display ? spec.display(v, ctx.byId.get(docId)!.extraction.document) : v);
    thread.consensus = result.consensus ? show(result.consensus[0].value, result.consensus[0].docId) : null;

    for (const d of ctx.docs) {
      const r = readings.find((x) => x.docId === d.id);
      let state: ThreadCellState;
      if (r) state = consensusIds.has(d.id) ? "agree" : "conflict";
      else state = spec.carriers.includes(d.extraction.document.docType) ? "missing" : "na";
      thread.cells.push({ docId: d.id, value: r ? show(r.value, d.id) : null, state });
    }

    if (result.outliers.length > 0 && result.consensus) {
      const rule = RULE_MAP[spec.ruleId];
      const outlierTypes = result.outliers.map((o) => o.docType);
      const severity = spec.severityFor ? spec.severityFor(outlierTypes, rule.severity) : rule.severity;
      const consensusValue = show(result.consensus[0].value, result.consensus[0].docId);
      const outlierText = result.outliers.map((o) => `the ${ctx.label(o.docId)} reads ${quote(show(o.value, o.docId))}`).join("; ");
      const evidence: Evidence[] = readings.map((r) => ({
        docId: r.docId, value: show(r.value, r.docId), location: spec.label, agrees: consensusIds.has(r.docId),
      }));
      const id = `${spec.ruleId}:${spec.field}`;
      push(ctx, {
        id, ruleId: spec.ruleId, severity, category: spec.category,
        title: `${spec.label} differs on the ${listLabels(ctx, result.outliers.map((o) => o.docId))}`,
        detail: `${capitalize(outlierText)}, while the ${listLabels(ctx, [...consensusIds])} ${consensusIds.size > 1 ? "agree on" : "reads"} ${quote(consensusValue)}. ${rule.why}`,
        suggestion: spec.suggestion,
        field: spec.field, evidence, valueAtRisk: null,
        suspectDocId: result.outliers.length === 1 ? result.outliers[0].docId : null,
      });
      thread.issueIds.push(id);
    }

    // Required-but-missing.
    for (const d of ctx.docs) {
      const t = d.extraction.document.docType;
      if (!spec.requiredOn?.includes(t)) continue;
      if (readings.some((r) => r.docId === d.id)) continue;
      const id = `valid.required_fields:${spec.field}:${d.id}`;
      push(ctx, {
        id, ruleId: "valid.required_fields", severity: spec.ruleId.startsWith("party.") && t !== "packing_list" ? "blocker" : "warning",
        title: `${spec.label} missing on the ${ctx.label(d.id)}`,
        detail: `No ${spec.label.toLowerCase()} could be found on the ${ctx.label(d.id)}. ${RULE_MAP[spec.ruleId].why}`,
        suggestion: thread.consensus
          ? `Add ${quote(thread.consensus)} (the value on the other documents) to the ${ctx.label(d.id)}.`
          : `Add the ${spec.label.toLowerCase()} to the ${ctx.label(d.id)}.`,
        field: spec.field,
        evidence: [{ docId: d.id, value: null, location: spec.label, agrees: false }],
        valueAtRisk: null, suspectDocId: d.id,
      });
      thread.issueIds.push(id);
    }

    if (readings.length > 0) ctx.threads.push(thread);
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lineDisplayQty(l: LineItem): string | null {
  if (l.quantity == null) return null;
  return `${fmtNumber(l.quantity)}${l.unit ? ` ${l.unit}` : ""}`;
}

function checkLines(ctx: Ctx) {
  const matches = matchLines(ctx.docs);
  const lineDocs = ctx.docs.filter((d) => d.extraction.document.lineItems.length > 0);
  const typeOf = (id: string) => ctx.byId.get(id)!.extraction.document.docType;
  const lineOf = (id: string, idx: number) => ctx.byId.get(id)!.extraction.document.lineItems[idx];

  for (const m of matches) {
    const present = Object.keys(m.members);
    const presentTypes = present.map(typeOf);
    const missing = lineDocs.filter((d) => !(d.id in m.members));
    const short = m.label.length > 60 ? `${m.label.slice(0, 57)}…` : m.label;
    const invId = present.find((id) => typeOf(id) === "commercial_invoice");
    const invLine = invId ? lineOf(invId, m.members[invId]) : null;
    const unitPrice = invLine?.unitPrice ?? present.map((id) => lineOf(id, m.members[id]).unitPrice).find((p) => p != null) ?? null;

    // --- Missing lines --------------------------------------------------
    if (missing.length > 0) {
      let severity: Severity = "advisory";
      const reasons: string[] = [];
      for (const d of missing) {
        const t = d.extraction.document.docType;
        if (t === "packing_list" && presentTypes.includes("commercial_invoice")) {
          severity = maxSeverity(severity, "blocker");
          reasons.push("it is invoiced but not on the packing list (customs will treat it as not shipped)");
        } else if (t === "commercial_invoice" && presentTypes.includes("packing_list")) {
          severity = maxSeverity(severity, "blocker");
          reasons.push("it is packed but not invoiced (undeclared goods)");
        } else if (t === "commercial_invoice" && presentTypes.every((x) => x === "purchase_order")) {
          severity = maxSeverity(severity, ctx.settings.allowPartialShipments ? "advisory" : "warning");
          reasons.push("it is on the purchase order but not in this shipment (partial shipment / backorder)");
        } else if (t === "purchase_order") {
          severity = maxSeverity(severity, "warning");
          reasons.push("it is shipped but was never ordered on the purchase order");
        } else {
          reasons.push(`it is not listed on the ${ctx.label(d.id)}`);
        }
      }
      const id = `line.missing:${m.key}`;
      const qtyLine = lineOf(present[0], m.members[present[0]]);
      push(ctx, {
        id, ruleId: "line.missing", severity,
        title: `“${short}” is missing from the ${listLabels(ctx, missing.map((d) => d.id))}`,
        detail: `This item appears on the ${listLabels(ctx, present)} but ${reasons.join("; and ")}.`,
        suggestion: severity === "advisory"
          ? "Confirm the backorder with the buyer so the open PO balance is expected."
          : "Either add the item to the missing document or remove it from the others — the documents must describe exactly the same goods.",
        field: `${m.key}.qty`,
        evidence: [
          ...present.map((id) => ({ docId: id, value: lineDisplayQty(lineOf(id, m.members[id])), location: `${m.key} · present`, agrees: true })),
          ...missing.map((d) => ({ docId: d.id, value: null, location: `${m.key} · absent`, agrees: false })),
        ],
        valueAtRisk: severity === "advisory" ? null : lineValue(qtyLine),
        suspectDocId: missing.length === 1 ? missing[0].id : null,
      });
    }

    // --- Threads per attribute -------------------------------------------
    const qtyThread = makeLineThread(ctx, m.key, "qty", `${m.key} · Quantity`, m.members, (l) => lineDisplayQty(l));
    const descThread = makeLineThread(ctx, m.key, "desc", `${m.key} · Description`, m.members, (l) => l.description);
    const hsThread = makeLineThread(ctx, m.key, "hs", `${m.key} · HS code`, m.members, (l) => l.hsCode);
    const priceThread = makeLineThread(ctx, m.key, "price", `${m.key} · Unit price`, m.members, (l) => (l.unitPrice != null ? fmtMoney(l.unitPrice, null) : null));

    // --- Quantity ----------------------------------------------------------
    const qtyReadings: Reading<{ qty: number; unit: string | null; raw: string }>[] = [];
    for (const id of present) {
      const l = lineOf(id, m.members[id]);
      if (l.quantity == null) continue;
      const base = toBaseQuantity(l.quantity, l.unit);
      qtyReadings.push({ docId: id, docType: typeOf(id), value: { qty: base.qty!, unit: base.unit, raw: lineDisplayQty(l)! } });
    }
    const shipQty = qtyReadings.filter((r) => SHIPPING_DOCS.includes(r.docType));
    const incompatible = shipQty.some((a) => shipQty.some((b) => !unitsCompatible(a.value.unit, b.value.unit)));
    if (incompatible) {
      push(ctx, {
        id: `line.quantity:${m.key}:units`, ruleId: "line.quantity", severity: "warning",
        title: `Different units of measure for “${short}”`,
        detail: `The documents count this item in incompatible units (${shipQty.map((r) => `${ctx.label(r.docId)}: ${r.value.raw}`).join(", ")}), so quantities cannot be reconciled.`,
        suggestion: "State the same unit of measure on the invoice and packing list (add the secondary unit in brackets if needed).",
        field: `${m.key}.qty`,
        evidence: shipQty.map((r) => ({ docId: r.docId, value: r.value.raw, location: `${m.key} · Qty`, agrees: false })),
        valueAtRisk: null, suspectDocId: null,
      });
    } else if (shipQty.length > 1) {
      const res = consensus(shipQty, (a, b) => Math.abs(a.qty - b.qty) < 1e-6, ["packing_list", "commercial_invoice", "certificate_of_origin"]);
      if (res.outliers.length > 0 && res.consensus) {
        const c = res.consensus[0].value;
        const delta = Math.max(...res.outliers.map((o) => Math.abs(o.value.qty - c.qty)));
        const id = `line.quantity:${m.key}`;
        push(ctx, {
          id, ruleId: "line.quantity", severity: "blocker",
          title: `Quantity mismatch on “${short}”`,
          detail: `${capitalize(res.outliers.map((o) => `the ${ctx.label(o.docId)} shows ${o.value.raw}`).join("; "))}, but the ${listLabels(ctx, res.consensus.map((r) => r.docId))} ${res.consensus.length > 1 ? "show" : "shows"} ${c.raw}. ${RULE_MAP["line.quantity"].why}`,
          suggestion: "Recount the goods against the packing list, then correct whichever document is wrong before filing.",
          field: `${m.key}.qty`,
          evidence: qtyReadings.map((r) => ({ docId: r.docId, value: r.value.raw, location: `${m.key} · Qty`, agrees: res.consensus!.some((x) => x.docId === r.docId) })),
          valueAtRisk: unitPrice != null ? round(delta * unitPrice) : null,
          suspectDocId: res.outliers.length === 1 ? res.outliers[0].docId : null,
        });
        qtyThread.issueIds.push(id);
        markThread(qtyThread, res.outliers.map((o) => o.docId));
      }
    }
    // Shipped vs ordered.
    const poReading = qtyReadings.find((r) => r.docType === "purchase_order");
    const shipRef = shipQty.find((r) => r.docType === "commercial_invoice") ?? shipQty[0];
    if (poReading && shipRef && unitsCompatible(poReading.value.unit, shipRef.value.unit) && Math.abs(poReading.value.qty - shipRef.value.qty) > 1e-6) {
      const over = shipRef.value.qty > poReading.value.qty;
      const id = `line.quantity:${m.key}:po`;
      const severity: Severity = over ? "warning" : ctx.settings.allowPartialShipments ? "advisory" : "warning";
      push(ctx, {
        id, ruleId: "line.quantity", severity,
        title: over ? `Over-shipment of “${short}”` : `Partial shipment of “${short}”`,
        detail: over
          ? `The ${ctx.label(shipRef.docId)} ships ${shipRef.value.raw} but only ${poReading.value.raw} were ordered. Buyers commonly reject or short-pay quantities above the PO.`
          : `The ${ctx.label(shipRef.docId)} ships ${shipRef.value.raw} of the ${poReading.value.raw} ordered.`,
        suggestion: over
          ? "Get written approval from the buyer for the extra quantity, or reduce the shipment to the PO quantity."
          : "Note the balance as backordered on the invoice so the buyer expects a second shipment.",
        field: `${m.key}.qty`,
        evidence: [poReading, shipRef].map((r) => ({ docId: r.docId, value: r.value.raw, location: `${m.key} · Qty`, agrees: r === poReading })),
        valueAtRisk: over && unitPrice != null ? round((shipRef.value.qty - poReading.value.qty) * unitPrice) : null,
        suspectDocId: over ? shipRef.docId : null,
      });
      qtyThread.issueIds.push(id);
      if (over) markThread(qtyThread, [shipRef.docId]);
    }

    // --- Description -------------------------------------------------------
    // Purchase orders routinely abbreviate descriptions; customs compares the shipping documents.
    const descs = present
      .filter((id) => SHIPPING_DOCS.includes(typeOf(id)))
      .map((id) => ({ id, d: lineOf(id, m.members[id]).description }))
      .filter((x): x is { id: string; d: string } => !!x.d);
    if (descs.length > 1) {
      const ref = descs.find((x) => typeOf(x.id) === "commercial_invoice") ?? descs[0];
      const drifted = descs.filter((x) => x !== ref && descriptionSimilarity(x.d, ref.d) < ctx.settings.descriptionSimilarity);
      if (drifted.length > 0) {
        const id = `line.description:${m.key}`;
        push(ctx, {
          id, ruleId: "line.description", severity: "warning",
          title: `Description of “${short}” differs between documents`,
          detail: `The ${ctx.label(ref.id)} describes it as ${quote(ref.d)}; ${drifted.map((x) => `the ${ctx.label(x.id)} says ${quote(x.d)}`).join("; ")}. ${RULE_MAP["line.description"].why}`,
          suggestion: "Use one precise goods description (material, function, model) on every document — copy it from the invoice.",
          field: `${m.key}.desc`,
          evidence: descs.map((x) => ({ docId: x.id, value: x.d, location: `${m.key} · Description`, agrees: !drifted.includes(x) })),
          valueAtRisk: null,
          suspectDocId: drifted.length === 1 ? drifted[0].id : null,
        });
        descThread.issueIds.push(id);
        markThread(descThread, drifted.map((x) => x.id));
      }
    }

    // --- HS code ---------------------------------------------------------------
    const hsReadings: Reading<string>[] = present
      .map((id) => ({ docId: id, docType: typeOf(id), value: normHs(lineOf(id, m.members[id]).hsCode) }))
      .filter((r) => r.value.length >= 6);
    if (hsReadings.length > 1) {
      const res6 = consensus(hsReadings, (a, b) => a.slice(0, 6) === b.slice(0, 6), ["commercial_invoice", "certificate_of_origin", "packing_list", "purchase_order"]);
      const rawHs = (id: string) => lineOf(id, m.members[id]).hsCode;
      if (res6.outliers.length > 0 && res6.consensus) {
        const id = `line.hs_code:${m.key}`;
        push(ctx, {
          id, ruleId: "line.hs_code", severity: "blocker",
          title: `Conflicting HS classification for “${short}”`,
          detail: `${capitalize(res6.outliers.map((o) => `the ${ctx.label(o.docId)} classifies it under ${rawHs(o.docId)}`).join("; "))}, but the ${listLabels(ctx, res6.consensus.map((r) => r.docId))} use ${rawHs(res6.consensus[0].docId)}. The first six digits are the international heading — they must be identical. ${RULE_MAP["line.hs_code"].why}`,
          suggestion: "Confirm the classification (ideally with a binding tariff ruling) and use the same code on every document.",
          field: `${m.key}.hs`,
          evidence: hsReadings.map((r) => ({ docId: r.docId, value: rawHs(r.docId), location: `${m.key} · HS`, agrees: res6.consensus!.some((x) => x.docId === r.docId) })),
          valueAtRisk: null,
          suspectDocId: res6.outliers.length === 1 ? res6.outliers[0].docId : null,
        });
        hsThread.issueIds.push(id);
        markThread(hsThread, res6.outliers.map((o) => o.docId));
      } else {
        const full = consensus(hsReadings, (a, b) => a === b || a.startsWith(b) || b.startsWith(a));
        if (full.outliers.length > 0) {
          const id = `line.hs_code:${m.key}:national`;
          push(ctx, {
            id, ruleId: "line.hs_code", severity: "advisory",
            title: `National tariff digits differ for “${short}”`,
            detail: `All documents agree on heading ${hsReadings[0].value.slice(0, 6)}, but the national subheadings differ (${hsReadings.map((r) => `${ctx.label(r.docId)}: ${rawHs(r.docId)}`).join(", ")}). This is normal between export and import tariffs but must be consistent within one country's filings.`,
            suggestion: "Use the importing country's full tariff code on the invoice if the buyer requests it.",
            field: `${m.key}.hs`,
            evidence: hsReadings.map((r) => ({ docId: r.docId, value: rawHs(r.docId), location: `${m.key} · HS`, agrees: full.consensus!.some((x) => x.docId === r.docId) })),
            valueAtRisk: null, suspectDocId: null,
          });
          hsThread.issueIds.push(id);
        }
      }
    }

    // --- Unit price ----------------------------------------------------------
    const priceReadings: Reading<number>[] = present
      .map((id) => ({ docId: id, docType: typeOf(id), value: lineOf(id, m.members[id]).unitPrice }))
      .filter((r): r is Reading<number> => r.value != null);
    if (priceReadings.length > 1) {
      const res = consensus(priceReadings, (a, b) => withinTolerance(a, b, ctx.settings.valueTolerancePct), ["purchase_order", "commercial_invoice"]);
      if (res.outliers.length > 0 && res.consensus) {
        const agreed = res.consensus[0].value;
        const qty = invLine?.quantity ?? lineOf(present[0], m.members[present[0]]).quantity ?? 0;
        const worst = res.outliers.reduce((a, b) => (Math.abs(b.value - agreed) > Math.abs(a.value - agreed) ? b : a));
        const id = `line.unit_price:${m.key}`;
        push(ctx, {
          id, ruleId: "line.unit_price", severity: "warning",
          title: `Unit price for “${short}” differs from the agreed price`,
          detail: `${capitalize(res.outliers.map((o) => `the ${ctx.label(o.docId)} prices it at ${fmtMoney(o.value, ctx.currency)}`).join("; "))}, while the ${listLabels(ctx, res.consensus.map((r) => r.docId))} ${res.consensus.length > 1 ? "show" : "shows"} ${fmtMoney(agreed, ctx.currency)}. Across ${fmtNumber(qty)} units that is ${fmtMoney(Math.abs(worst.value - agreed) * qty, ctx.currency)}. ${RULE_MAP["line.unit_price"].why}`,
          suggestion: "Invoice at the PO price, or attach the buyer's approved price change before submitting.",
          field: `${m.key}.price`,
          evidence: priceReadings.map((r) => ({ docId: r.docId, value: fmtMoney(r.value, ctx.currency), location: `${m.key} · Unit price`, agrees: res.consensus!.some((x) => x.docId === r.docId) })),
          valueAtRisk: round(Math.abs(worst.value - agreed) * qty),
          suspectDocId: res.outliers.length === 1 ? res.outliers[0].docId : null,
        });
        priceThread.issueIds.push(id);
        markThread(priceThread, res.outliers.map((o) => o.docId));
      }
    }

    // --- Line weights ------------------------------------------------------------
    const qtyFlagged = ctx.issues.some((i) => i.id === `line.quantity:${m.key}`);
    for (const key of qtyFlagged ? [] : (["grossWeightKg", "netWeightKg"] as const)) {
      const wr: Reading<number>[] = present
        .map((id) => ({ docId: id, docType: typeOf(id), value: lineOf(id, m.members[id])[key] }))
        .filter((r): r is Reading<number> => r.value != null);
      if (wr.length < 2) continue;
      const res = consensus(wr, (a, b) => withinTolerance(a, b, ctx.settings.weightTolerancePct), ["packing_list", "commercial_invoice"]);
      if (res.outliers.length > 0 && res.consensus) {
        const label = key === "grossWeightKg" ? "gross" : "net";
        push(ctx, {
          id: `line.weight:${m.key}:${label}`, ruleId: "line.weight", severity: "advisory",
          title: `Line ${label} weight differs for “${short}”`,
          detail: `${wr.map((r) => `${ctx.label(r.docId)}: ${fmtNumber(r.value, 2)} kg`).join(", ")}.`,
          suggestion: "Take line weights from the packing list.",
          field: `${m.key}.qty`,
          evidence: wr.map((r) => ({ docId: r.docId, value: `${fmtNumber(r.value, 2)} kg`, location: `${m.key} · ${label} wt`, agrees: res.consensus!.some((x) => x.docId === r.docId) })),
          valueAtRisk: null, suspectDocId: res.outliers.length === 1 ? res.outliers[0].docId : null,
        });
      }
    }

    for (const t of [qtyThread, descThread, hsThread, priceThread]) {
      if (t.cells.some((c) => c.value != null)) ctx.threads.push(t);
    }
  }
  return matches;
}

function lineValue(l: LineItem): number | null {
  if (l.amount != null) return l.amount;
  if (l.quantity != null && l.unitPrice != null) return round(l.quantity * l.unitPrice);
  return null;
}

function makeLineThread(
  ctx: Ctx, key: string, attr: string, label: string, members: Record<string, number>, read: (l: LineItem) => string | null,
): Thread {
  const cells = ctx.docs.map((d) => {
    const hasLines = d.extraction.document.lineItems.length > 0;
    if (!(d.id in members)) return { docId: d.id, value: null, state: (hasLines ? "missing" : "na") as ThreadCellState };
    const v = read(d.extraction.document.lineItems[members[d.id]]);
    return { docId: d.id, value: v, state: (v == null ? "missing" : "agree") as ThreadCellState };
  });
  const consensusValue = cells.find((c) => c.value != null)?.value ?? null;
  return { field: `${key}.${attr}`, label, group: "lines", cells, consensus: consensusValue, issueIds: [] };
}

function markThread(t: Thread, docIds: string[]) {
  for (const c of t.cells) if (docIds.includes(c.docId) && c.value != null) c.state = "conflict";
  t.consensus = t.cells.find((c) => c.state === "agree")?.value ?? t.consensus;
}

function checkArithmetic(ctx: Ctx) {
  for (const d of ctx.docs) {
    const doc = d.extraction.document;
    const lines = doc.lineItems;
    const label = ctx.label(d.id);

    lines.forEach((l, i) => {
      if (l.quantity == null || l.unitPrice == null || l.amount == null) return;
      const expected = round(l.quantity * l.unitPrice);
      const diff = Math.abs(expected - l.amount);
      if (diff > Math.max(0.011, Math.abs(l.amount) * 0.001)) {
        push(ctx, {
          id: `math.line_extension:${d.id}:${i}`, ruleId: "math.line_extension", severity: doc.docType === "commercial_invoice" ? "warning" : "advisory",
          title: `Line ${l.lineNo ?? i + 1} on the ${label} does not add up`,
          detail: `${fmtNumber(l.quantity)} × ${fmtMoney(l.unitPrice, null)} = ${fmtMoney(expected, ctx.currency)}, but the line amount is ${fmtMoney(l.amount, ctx.currency)} (off by ${fmtMoney(diff, ctx.currency)}).`,
          suggestion: "Recalculate the line amount — spreadsheet rounding or a stale unit price are the usual causes.",
          field: "totals.amount",
          evidence: [{ docId: d.id, value: fmtMoney(l.amount, ctx.currency), location: `Line ${l.lineNo ?? i + 1} · Amount`, agrees: false }],
          valueAtRisk: round(diff), suspectDocId: d.id,
        });
      }
    });

    if (doc.totals.amount != null && lines.length > 0 && lines.every((l) => lineValue(l) != null)) {
      const sum = round(lines.reduce((a, l) => a + (lineValue(l) ?? 0), 0));
      const diff = Math.abs(sum - doc.totals.amount);
      // Allow for freight/insurance lines under CIF/CFR not itemised: only flag above tolerance.
      if (diff > Math.max(0.011, doc.totals.amount * ctx.settings.valueTolerancePct)) {
        push(ctx, {
          id: `math.total_value:${d.id}`, ruleId: "math.total_value", severity: doc.docType === "commercial_invoice" ? "blocker" : "warning",
          title: `Lines do not add up to the ${label} total`,
          detail: `The line amounts sum to ${fmtMoney(sum, ctx.currency)}, but the stated total is ${fmtMoney(doc.totals.amount, ctx.currency)} — a difference of ${fmtMoney(diff, ctx.currency)}. If freight, insurance or discounts are included, they must be itemised.`,
          suggestion: "Either itemise the extra charges (freight, insurance, discount) or correct the total to the sum of lines.",
          field: "totals.amount",
          evidence: [
            { docId: d.id, value: fmtMoney(doc.totals.amount, ctx.currency), location: "Stated total", agrees: false },
            { docId: d.id, value: fmtMoney(sum, ctx.currency), location: "Sum of lines", agrees: true },
          ],
          valueAtRisk: round(diff), suspectDocId: d.id,
        });
      }
    }

    const totalChecks: { key: "packages" | "grossWeightKg" | "netWeightKg"; label: string; rel: number }[] = [
      { key: "packages", label: "packages", rel: 0 },
      { key: "grossWeightKg", label: "gross weight", rel: ctx.settings.weightTolerancePct / 2 },
      { key: "netWeightKg", label: "net weight", rel: ctx.settings.weightTolerancePct / 2 },
    ];
    for (const tc of totalChecks) {
      const stated = doc.totals[tc.key];
      if (stated == null || lines.length === 0 || !lines.every((l) => l[tc.key] != null)) continue;
      const sum = round(lines.reduce((a, l) => a + (l[tc.key] ?? 0), 0), 3);
      if (!withinTolerance(sum, stated, tc.rel, 0.01)) {
        push(ctx, {
          id: `math.totals:${d.id}:${tc.key}`, ruleId: "math.totals", severity: "warning",
          title: `Line ${tc.label} does not add up on the ${label}`,
          detail: `Lines sum to ${fmtNumber(sum, tc.key === "packages" ? 0 : 2)} but the total says ${fmtNumber(stated, tc.key === "packages" ? 0 : 2)}.`,
          suggestion: `Correct the total ${tc.label} or the line that is wrong.`,
          field: `totals.${tc.key}`,
          evidence: [
            { docId: d.id, value: fmtNumber(stated, 2), location: `Total ${tc.label}`, agrees: false },
            { docId: d.id, value: fmtNumber(sum, 2), location: `Sum of lines`, agrees: true },
          ],
          valueAtRisk: null, suspectDocId: d.id,
        });
      }
    }

    const ng = (net: number | null, gross: number | null, where: string, id: string) => {
      if (net != null && gross != null && net > gross + 0.001) {
        push(ctx, {
          id, ruleId: "math.net_gross", severity: "warning",
          title: `Net weight exceeds gross weight on the ${label}`,
          detail: `${where}: net ${fmtNumber(net, 2)} kg is greater than gross ${fmtNumber(gross, 2)} kg — the two columns are probably swapped.`,
          suggestion: "Swap or correct the weights; gross weight includes packaging and is always the larger figure.",
          field: "totals.grossWeightKg",
          evidence: [{ docId: d.id, value: `${fmtNumber(net, 2)} / ${fmtNumber(gross, 2)} kg`, location: where, agrees: false }],
          valueAtRisk: null, suspectDocId: d.id,
        });
      }
    };
    ng(doc.totals.netWeightKg, doc.totals.grossWeightKg, "Totals", `math.net_gross:${d.id}`);
    lines.forEach((l, i) => ng(l.netWeightKg, l.grossWeightKg, `Line ${l.lineNo ?? i + 1}`, `math.net_gross:${d.id}:${i}`));
  }
}

function checkValidity(ctx: Ctx) {
  for (const d of ctx.docs) {
    const doc = d.extraction.document;
    const label = ctx.label(d.id);
    for (const c of doc.containerNumbers) {
      const r = containerCheck(c);
      if (!r.valid) {
        push(ctx, {
          id: `valid.container_check_digit:${d.id}:${r.normalized}`, ruleId: "valid.container_check_digit", severity: "warning",
          title: `Container ${r.normalized} fails the ISO 6346 check`,
          detail: `${r.reason}. A container number that fails its check digit was almost certainly mistyped on the ${label}.`,
          suggestion: "Copy the container number from the gate-in (EIR) receipt or the carrier's booking.",
          field: "containerNumbers",
          evidence: [{ docId: d.id, value: r.normalized, location: "Container", agrees: false }],
          valueAtRisk: null, suspectDocId: d.id,
        });
      }
    }
    const missingHs: number[] = [];
    doc.lineItems.forEach((l, i) => {
      if (!l.hsCode) {
        missingHs.push(l.lineNo ?? i + 1);
        return;
      }
      if (!isValidHs(l.hsCode)) {
        push(ctx, {
          id: `valid.hs_format:${d.id}:${i}`, ruleId: "valid.hs_format", severity: "warning",
          title: `Malformed HS code on the ${label}, line ${l.lineNo ?? i + 1}`,
          detail: `“${l.hsCode}” is not a valid harmonised code — codes have 6, 8 or 10 digits.`,
          suggestion: "Correct the code; check for a dropped leading zero (e.g. 0901 coffee).",
          field: "hs", evidence: [{ docId: d.id, value: l.hsCode, location: `Line ${l.lineNo ?? i + 1} · HS`, agrees: false }],
          valueAtRisk: null, suspectDocId: d.id,
        });
      }
    });
    if (doc.docType === "commercial_invoice" && missingHs.length > 0) {
      push(ctx, {
        id: `valid.hs_missing:${d.id}`, ruleId: "valid.hs_missing", severity: "advisory",
        title: `HS codes missing on ${missingHs.length} invoice line${missingHs.length > 1 ? "s" : ""}`,
        detail: `Line${missingHs.length > 1 ? "s" : ""} ${missingHs.join(", ")} on the ${label} carr${missingHs.length > 1 ? "y" : "ies"} no HS code. ${RULE_MAP["valid.hs_missing"].why}`,
        suggestion: "Add the 6-digit (or importing country's full) tariff code to each line.",
        field: "hs", evidence: [{ docId: d.id, value: null, location: "HS codes", agrees: false }],
        valueAtRisk: null, suspectDocId: d.id,
      });
    }
    if (doc.incoterm) {
      const st = incotermStatus(doc.incoterm);
      if (st !== "valid") {
        push(ctx, {
          id: `valid.incoterm:${d.id}`, ruleId: "valid.incoterm", severity: st === "legacy" ? "advisory" : "warning",
          title: st === "legacy" ? `Non-standard Incoterm “${doc.incoterm}” on the ${label}` : `Unrecognised Incoterm on the ${label}`,
          detail: st === "legacy"
            ? `“${doc.incoterm}” is not a current Incoterms® 2020 rule (use ${normIncoterm(doc.incoterm)}). ${RULE_MAP["valid.incoterm"].why}`
            : `“${doc.incoterm}” is not an Incoterms 2020 rule (EXW, FCA, CPT, CIP, DAP, DPU, DDP, FAS, FOB, CFR, CIF).`,
          suggestion: st === "legacy" ? "Replace C&F/CNF with CFR, DDU with DAP and DAT with DPU, and state “Incoterms® 2020” after the named place." : "State a valid Incoterm with its named place.",
          field: "incoterm", evidence: [{ docId: d.id, value: doc.incoterm, location: "Incoterm", agrees: false }],
          valueAtRisk: null, suspectDocId: d.id,
        });
      }
    }
  }
  // Date order: PO must not be dated after the invoice.
  const po = ctx.docs.find((d) => d.extraction.document.docType === "purchase_order");
  const inv = ctx.docs.find((d) => d.extraction.document.docType === "commercial_invoice");
  const poDate = po?.extraction.document.docDate;
  const invDate = inv?.extraction.document.docDate;
  if (po && inv && poDate && invDate && poDate > invDate) {
    push(ctx, {
      id: "valid.date_order", ruleId: "valid.date_order", severity: "advisory",
      title: "Invoice is dated before its purchase order",
      detail: `The invoice is dated ${invDate} but the purchase order is dated ${poDate}.`,
      suggestion: "Check that the invoice date is correct — reused templates often carry an old date.",
      field: "docDate",
      evidence: [
        { docId: po.id, value: poDate, location: "Date", agrees: true },
        { docId: inv.id, value: invDate, location: "Date", agrees: false },
      ],
      valueAtRisk: null, suspectDocId: inv.id,
    });
  }
}

function checkTotalValue(ctx: Ctx) {
  const po = ctx.docs.find((d) => d.extraction.document.docType === "purchase_order");
  const inv = ctx.docs.find((d) => d.extraction.document.docType === "commercial_invoice");
  if (!po || !inv) return;
  const a = po.extraction.document.totals.amount;
  const b = inv.extraction.document.totals.amount;
  if (a == null || b == null || withinTolerance(a, b, ctx.settings.valueTolerancePct)) return;
  // A shipment smaller than the order is expected under partial shipments.
  const linesShort = ctx.issues.some((i) => i.ruleId === "line.missing" && i.severity === "advisory") ||
    ctx.issues.some((i) => i.id.endsWith(":po") && i.title.startsWith("Partial"));
  if (b < a && linesShort && ctx.settings.allowPartialShipments) return;
  const id = "commercial.total_value";
  push(ctx, {
    id, ruleId: id, severity: "warning",
    title: `Invoice total ${b > a ? "exceeds" : "is below"} the purchase order`,
    detail: `The invoice totals ${fmtMoney(b, ctx.currency)} against a PO value of ${fmtMoney(a, ctx.currency)} (${b > a ? "+" : "−"}${fmtMoney(Math.abs(b - a), ctx.currency)}). ${RULE_MAP[id].why}`,
    suggestion: "Reconcile the difference line by line; any surcharge must be pre-approved by the buyer.",
    field: "totals.amount",
    evidence: [
      { docId: po.id, value: fmtMoney(a, ctx.currency), location: "Total", agrees: true },
      { docId: inv.id, value: fmtMoney(b, ctx.currency), location: "Total", agrees: false },
    ],
    valueAtRisk: round(Math.abs(b - a)), suspectDocId: inv.id,
  });
  const thread: Thread = {
    field: "totals.amount", label: "Total value", group: "commercial", consensus: fmtMoney(a, ctx.currency), issueIds: [id],
    cells: ctx.docs.map((d) => {
      const v = d.extraction.document.totals.amount;
      const t = d.extraction.document.docType;
      return { docId: d.id, value: v != null ? fmtMoney(v, ctx.currency) : null, state: v == null ? (t === "commercial_invoice" || t === "purchase_order" ? "missing" : "na") : d.id === inv.id ? "conflict" : "agree" } as Thread["cells"][number];
    }),
  };
  ctx.threads.push(thread);
}

export function score(issues: Issue[]): number {
  const penalty = issues.reduce((a, i) => a + SEVERITY_WEIGHT[i.severity], 0);
  return Math.round(100 * Math.exp(-penalty / 55));
}

export function verdictFor(issues: Issue[]): ReconciliationReport["verdict"] {
  if (issues.some((i) => i.severity === "blocker")) return "hold";
  if (issues.some((i) => i.severity === "warning")) return "review";
  return "cleared";
}

/**
 * Cross-check every document in a pack. Pure and deterministic: the same
 * documents and settings always produce the same report, issue ids included,
 * so reviewer decisions (resolve / accept) survive re-analysis.
 */
export function reconcile(docs: PackDocument[], settings: RuleSettings = DEFAULT_RULE_SETTINGS): ReconciliationReport {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const label = docLabeler(docs);
  const currencies = consensus(
    docs
      .map((d) => ({ docId: d.id, docType: d.extraction.document.docType, value: normCurrency(d.extraction.document.currency) }))
      .filter((r): r is Reading<string> => !!r.value),
    (a, b) => a === b,
    ["commercial_invoice", "purchase_order"],
  );
  const ctx: Ctx = {
    docs, byId, settings, issues: [], threads: [], label,
    currency: currencies.consensus?.[0].value ?? null,
  };

  checkHeaders(ctx);
  const lineMatches = checkLines(ctx);
  checkArithmetic(ctx);
  checkValidity(ctx);
  checkTotalValue(ctx);

  const order = { blocker: 0, warning: 1, advisory: 2 };
  ctx.issues.sort((a, b) => order[a.severity] - order[b.severity] || (b.valueAtRisk ?? 0) - (a.valueAtRisk ?? 0));
  const valueAtRisk = round(ctx.issues.reduce((a, i) => a + (i.valueAtRisk ?? 0), 0));
  const fieldsCompared = ctx.threads.reduce((a, t) => a + t.cells.filter((c) => c.value != null).length, 0);

  return {
    score: score(ctx.issues),
    verdict: verdictFor(ctx.issues),
    currency: ctx.currency,
    issues: ctx.issues,
    threads: ctx.threads,
    lineMatches,
    valueAtRisk,
    stats: {
      documents: docs.length,
      fieldsCompared,
      linesCompared: lineMatches.length,
      blockers: ctx.issues.filter((i) => i.severity === "blocker").length,
      warnings: ctx.issues.filter((i) => i.severity === "warning").length,
      advisories: ctx.issues.filter((i) => i.severity === "advisory").length,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Recompute score/verdict counting only issues still open (after reviewer decisions). */
export function applyDecisions(report: ReconciliationReport, closedIssueIds: Set<string>) {
  const open = report.issues.filter((i) => !closedIssueIds.has(i.id));
  return {
    score: score(open),
    verdict: verdictFor(open),
    open,
    valueAtRisk: round(open.reduce((a, i) => a + (i.valueAtRisk ?? 0), 0)),
  };
}

import {
  emptyDocument,
  emptyLine,
  type DocType,
  type ExtractedDocument,
  type ExtractionResult,
  type LineItem,
  type Party,
} from "@/lib/domain/types";
import { isCountryWord, normCurrency, normDate, parseNumber } from "@/lib/engine/normalize";

/**
 * Layout parser. Works on a page of positioned text cells — produced either
 * from a digital PDF (x = points) or from a spreadsheet (x = column index) —
 * and recovers the canonical document: type, references, parties, line-item
 * table and totals. It is deliberately conservative: anything it is unsure of
 * is left null rather than guessed, and its confidence reflects coverage.
 */

export interface Cell {
  text: string;
  x0: number;
  x1: number;
}
export interface Row {
  y: number;
  cells: Cell[];
}

// ------------------------------------------------------------ Classification

const TYPE_TITLES: [DocType, RegExp][] = [
  ["commercial_invoice", /^(commercial|tax|export|customs)?\s*invoice$|^invoice\b(?!\s*(no|number|#|ref|date))/i],
  ["packing_list", /^packing\s*(list|slip|note)\b|^weight\s*(&|and)\s*packing/i],
  ["purchase_order", /^purchase\s*order\b|^p\.?\s?o\.?$/i],
  ["bill_of_lading", /bill\s+of\s+lading|sea\s*waybill|^b\/l\b/i],
  ["certificate_of_origin", /certificate\s+of\s+origin/i],
  ["shipping_instruction", /shipping\s+instructions?|shipper'?s\s+letter\s+of\s+instruction/i],
];

const FILE_HINTS: [DocType, RegExp][] = [
  ["commercial_invoice", /invoice|\binv\b/i],
  ["packing_list", /packing|\bpl\b/i],
  ["purchase_order", /purchase.?order|\bpo\b/i],
  ["bill_of_lading", /lading|\bb\/?l\b|\bbl\b|waybill|\bhbl\b|\bmbl\b/i],
  ["certificate_of_origin", /origin|\bcoo\b|\bco\b/i],
  ["shipping_instruction", /instruction|\bsi\b/i],
];

export function classify(rows: Row[], fileName = ""): { type: DocType; sure: boolean } {
  const score = new Map<DocType, number>();
  const add = (t: DocType, n: number) => score.set(t, (score.get(t) ?? 0) + n);
  const top = Math.max(4, Math.ceil(rows.length * 0.25));
  rows.forEach((row, ri) => {
    for (const c of row.cells) {
      const t = c.text.trim();
      if (t.length > 60) continue;
      for (const [type, re] of TYPE_TITLES) if (re.test(t)) add(type, ri < top ? 6 : 1);
    }
  });
  const base = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
  for (const [type, re] of FILE_HINTS) if (re.test(base)) add(type, 3);
  let best: DocType = "other";
  let bestScore = 0;
  for (const [t, s] of score) if (s > bestScore) [best, bestScore] = [t, s];
  return { type: best, sure: bestScore >= 6 };
}

// --------------------------------------------------------------- Key/values

type KvKey =
  | "invoiceNo" | "plNo" | "poNo" | "blNo" | "certNo" | "siNo" | "docNo" | "date" | "currency" | "incoterm"
  | "paymentTerms" | "origin" | "pol" | "pod" | "vessel" | "containers" | "totalPackages" | "totalGross"
  | "totalNet" | "totalCbm" | "totalAmount" | "totalQty";

const KV_LABELS: [KvKey, RegExp][] = [
  ["invoiceNo", /^(commercial\s+)?(invoice|inv\.?)\s*(no\.?|number|num|#|ref(erence)?)$/i],
  ["plNo", /^packing\s*list\s*(no\.?|number|#)$/i],
  ["poNo", /^(p\.?\s?o\.?|purchase\s+order|buyer'?s?\s+order|order|customer\s+po)\s*(no\.?|number|#|ref(erence)?)?$/i],
  ["blNo", /^(b\/?l|bill\s+of\s+lading|waybill|bol)\s*(no\.?|number|#)$/i],
  ["certNo", /^(certificate|cert\.?)\s*(no\.?|number|#)$/i],
  ["siNo", /^(si|shipping\s+instruction)\s*(no\.?|number|#)$/i],
  ["docNo", /^(document|doc\.?|reference|ref\.?)\s*(no\.?|number|#)?$/i],
  ["date", /^((invoice|issue|document|po|order|b\/l|shipment|shipped\s+on\s+board)\s+)?date(\s+of\s+issue)?$/i],
  ["currency", /^currency$|^curr\.?$/i],
  ["incoterm", /^(incoterms?(\s*®?\s*2020)?|terms\s+of\s+delivery|delivery\s+terms|price\s+terms|trade\s+terms)$/i],
  ["paymentTerms", /^(payment\s+terms|terms\s+of\s+payment|payment)$/i],
  ["origin", /^(country\s+of\s+origin(\s+of\s+goods)?|origin|made\s+in|c\.?o\.?o\.?)$/i],
  ["pol", /^(port\s+of\s+loading|loading\s+port|pol|port\s+of\s+shipment|place\s+of\s+loading)$/i],
  ["pod", /^(port\s+of\s+discharge|discharge\s+port|pod|destination\s+port|port\s+of\s+destination|final\s+destination)$/i],
  ["vessel", /^(vessel(\s*\/\s*voy(age)?\.?)?|ocean\s+vessel|vessel\s+name|voyage|flight\s*\/?\s*vessel)$/i],
  ["containers", /^(container\s*(no\.?|nos\.?|number)?\s*(\(s\))?s?|cntr\.?\s*(no\.?|nos\.?)?|containers?)$/i],
  ["totalPackages", /^(total\s+)?(no\.?\s+of\s+|number\s+of\s+)?(packages|pkgs|cartons|ctns)$/i],
  ["totalGross", /^(total\s+)?gross\s+w(eigh)?t\.?(\s*\(?kgs?\)?)?$|^g\.?\s?w\.?(\s*\(?kgs?\)?)?$/i],
  ["totalNet", /^(total\s+)?net\s+w(eigh)?t\.?(\s*\(?kgs?\)?)?$|^n\.?\s?w\.?(\s*\(?kgs?\)?)?$/i],
  ["totalCbm", /^(total\s+)?(measurement|volume|cbm)(\s*\(?cbm\)?)?$/i],
  ["totalAmount", /^(total\s+(amount|value|invoice\s+value)|grand\s+total|invoice\s+total|amount\s+due|total\s+fob\s+value|total)$/i],
  ["totalQty", /^total\s+(quantity|qty|units|pcs)$/i],
];

function matchKv(label: string): KvKey | null {
  const l = label.trim().replace(/\s+/g, " ").replace(/[.:]+$/, "");
  for (const [k, re] of KV_LABELS) if (re.test(l)) return k;
  return null;
}

type PartyKey = "shipper" | "consignee" | "notifyParty";
const PARTY_HEADINGS: [PartyKey, RegExp][] = [
  ["notifyParty", /^(notify(\s+party)?|also\s+notify)$/i],
  ["shipper", /^(shipper(\s*\/\s*exporter)?|exporter|seller|supplier(\s*\/\s*seller)?|vendor|consignor|manufacturer\s*\/\s*exporter)$/i],
  ["consignee", /^(consignee|buyer(\s*\/\s*ship\s*to)?|ship\s*to|importer|sold\s*to|deliver\s*to|bill\s*to)$/i],
];

function matchParty(label: string): PartyKey | null {
  const l = label.trim().replace(/[.:]+$/, "").replace(/\s+/g, " ");
  for (const [k, re] of PARTY_HEADINGS) if (re.test(l)) return k;
  return null;
}

function splitLabel(text: string): { label: string; value: string } | null {
  const m = text.match(/^([^:]{2,48}):\s*(.*)$/);
  return m ? { label: m[1], value: m[2].trim() } : null;
}

// ----------------------------------------------------------------- Columns

type ColKey = keyof Pick<LineItem, "lineNo" | "sku" | "description" | "hsCode" | "quantity" | "unit" | "unitPrice" | "amount" | "packages" | "netWeightKg" | "grossWeightKg" | "countryOfOrigin">;

const COLUMN_HEADERS: [ColKey, RegExp][] = [
  ["lineNo", /^(no\.?|s\.?\s?no\.?|sr\.?\s?(no\.?)?|#|line|pos\.?|item)$/i],
  ["unitPrice", /^(unit\s*(price|value|cost)|price(\s*\/\s*unit)?|rate|u\/?price|fob\s+price)(\s*\(.*\))?$/i],
  ["amount", /^(amount|total|value|line\s+total|extended|total\s+(amount|value|price)|ext\.?\s*price)(\s*\(.*\))?$/i],
  ["hsCode", /^(hs|h\.s\.|hts|tariff|commodity|customs)\s*(code|no\.?|number|heading)?$/i],
  ["description", /desc|goods|particulars|commodity\s+description|product\s+name|item\s+name|marks/i],
  ["sku", /^(item|article|art\.?|product|part|style|model|material)\s*(code|no\.?|number|#|ref)?$|^sku$|^code$|^ref\.?$/i],
  ["packages", /^(pkgs?|packages|cartons|ctns?|no\.?\s+of\s+(pkgs|packages|cartons)|packing)(\s*\(.*\))?$/i],
  ["netWeightKg", /^(n\.?\s?w\.?|net(\s*w(eigh)?t\.?)?)(\s*\(?kgs?\)?)?$/i],
  ["grossWeightKg", /^(g\.?\s?w\.?|gross(\s*w(eigh)?t\.?)?)(\s*\(?kgs?\)?)?$/i],
  ["quantity", /^(q'?ty|quantity|qnty|pcs|units|no\.?\s+of\s+units)(\s*\(.*\))?$/i],
  ["unit", /^(unit|uom|u\/m|units?\s+of\s+measure)$/i],
  ["countryOfOrigin", /^(origin|country\s+of\s+origin|c\/o)$/i],
];

function matchColumn(t: string): ColKey | null {
  const s = t.trim().replace(/\s+/g, " ");
  for (const [k, re] of COLUMN_HEADERS) if (re.test(s)) return k;
  return null;
}

interface Column {
  key: ColKey;
  x0: number;
  x1: number;
}

function overlap(a: Cell, c: Column): number {
  return Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
}

function assign(cell: Cell, cols: Column[]): Column {
  let best = cols[0];
  let bestScore = -Infinity;
  for (const c of cols) {
    const ov = overlap(cell, c);
    const centerDist = Math.abs((cell.x0 + cell.x1) / 2 - (c.x0 + c.x1) / 2);
    const s = ov > 0 ? 1000 + ov : -centerDist;
    if (s > bestScore) [best, bestScore] = [c, s];
  }
  return best;
}

function parseQtyCell(t: string): { qty: number | null; unit: string | null } {
  const m = t.trim().match(/^([\d.,\s]+)\s*([A-Za-z]{1,8})?\.?$/);
  if (!m) return { qty: parseNumber(t), unit: null };
  return { qty: parseNumber(m[1]), unit: m[2] ?? null };
}

function setLineField(line: LineItem, key: ColKey, text: string) {
  const t = text.trim();
  if (!t) return;
  switch (key) {
    case "lineNo": {
      const n = parseNumber(t);
      line.lineNo = n != null && Number.isInteger(n) ? n : line.lineNo;
      break;
    }
    case "sku": line.sku = line.sku ? `${line.sku} ${t}` : t; break;
    case "description": line.description = line.description ? `${line.description} ${t}` : t; break;
    case "hsCode": line.hsCode = t; break;
    case "unit": line.unit = t; break;
    case "countryOfOrigin": line.countryOfOrigin = t; break;
    case "quantity": {
      const q = parseQtyCell(t);
      line.quantity = q.qty;
      if (q.unit && !line.unit) line.unit = q.unit;
      break;
    }
    default:
      (line as unknown as Record<string, number | null>)[key] = parseNumber(t);
  }
}

// ------------------------------------------------------------------ Parser

export function parseGrid(rows: Row[], fileName = "", tolerance = 6): ExtractionResult {
  const warnings: string[] = [];
  const { type, sure } = classify(rows, fileName);
  const doc: ExtractedDocument = emptyDocument(type);
  const kv = new Map<KvKey, string>();
  const consumed = new Set<string>(); // "row:cell" keys used by parties/tables

  const setKv = (k: KvKey, v: string) => {
    if (v && !kv.has(k)) kv.set(k, v.trim());
  };

  // 1. Key/value pairs: "Label: value", or label cell followed by value cell.
  rows.forEach((row, ri) => {
    row.cells.forEach((cell, ci) => {
      const split = splitLabel(cell.text);
      if (split) {
        const k = matchKv(split.label);
        if (k && split.value) {
          setKv(k, split.value);
          consumed.add(`${ri}:${ci}`);
          return;
        }
        if (k && !split.value) {
          const next = row.cells[ci + 1] ?? findBelow(rows, ri, cell, tolerance);
          if (next) setKv(k, next.text);
          consumed.add(`${ri}:${ci}`);
          return;
        }
      }
      const k = matchKv(cell.text);
      if (k && row.cells[ci + 1] && !matchKv(row.cells[ci + 1].text) && !matchColumn(cell.text)) {
        setKv(k, row.cells[ci + 1].text);
        consumed.add(`${ri}:${ci}`);
        consumed.add(`${ri}:${ci + 1}`);
      }
    });
  });

  // 2. Party blocks: a heading followed by lines in the same column.
  rows.forEach((row, ri) => {
    row.cells.forEach((cell, ci) => {
      const inline = splitLabel(cell.text);
      const key = matchParty(inline ? inline.label : cell.text);
      if (!key || hasParty(doc[key])) return;
      const lines: string[] = inline?.value ? [inline.value] : [];
      let gaps = 0;
      for (let r = ri + 1; r < rows.length && lines.length < 9 && gaps < 2; r++) {
        const c = rows[r].cells.find((x) => Math.abs(x.x0 - cell.x0) <= tolerance);
        if (!c) {
          gaps++;
          continue;
        }
        const sp = splitLabel(c.text);
        if (matchParty(c.text) || matchParty(sp?.label ?? "") || (sp && matchKv(sp.label)) || matchKv(c.text) || matchColumn(c.text)) break;
        lines.push(c.text.trim());
        consumed.add(`${r}:${rows[r].cells.indexOf(c)}`);
      }
      consumed.add(`${ri}:${ci}`);
      doc[key] = toParty(lines);
    });
  });

  // 3. Line-item table.
  const headerIdx = rows.findIndex((row) => {
    const keys = row.cells.map((c) => matchColumn(c.text)).filter(Boolean);
    return new Set(keys).size >= 3 && (keys.includes("description") || keys.includes("quantity"));
  });
  if (headerIdx >= 0) {
    const header = rows[headerIdx];
    const cols: Column[] = [];
    for (const c of header.cells) {
      const k = matchColumn(c.text);
      if (k && !cols.some((x) => x.key === k)) cols.push({ key: k, x0: c.x0, x1: c.x1 });
    }
    cols.sort((a, b) => a.x0 - b.x0);
    let prev: LineItem | null = null;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.cells.length === 0) continue;
      const first = row.cells[0].text.trim();
      if (/^(sub\s*-?\s*)?(grand\s+)?total\b/i.test(first) || /^total\b/i.test(row.cells.map((c) => c.text).join(" "))) {
        for (const c of row.cells.slice(1)) {
          const col = assign(c, cols);
          const n = parseNumber(c.text);
          if (n == null) continue;
          if (col.key === "quantity") doc.totals.quantity = n;
          if (col.key === "amount") doc.totals.amount = n;
          if (col.key === "packages") doc.totals.packages = n;
          if (col.key === "netWeightKg") doc.totals.netWeightKg = n;
          if (col.key === "grossWeightKg") doc.totals.grossWeightKg = n;
        }
        break;
      }
      const sp = splitLabel(first);
      if ((sp && matchKv(sp.label)) || matchParty(first)) break;
      const line = emptyLine();
      const assigned = row.cells.map((c) => ({ c, col: assign(c, cols) }));
      for (const { c, col } of assigned) setLineField(line, col.key, c.text);
      const onlyText = assigned.every(({ col }) => col.key === "description" || col.key === "sku");
      const hasNumber = line.quantity != null || line.amount != null || line.unitPrice != null || line.packages != null;
      if (onlyText && prev) {
        // Wrapped description continuing from the line above.
        const extra = assigned.filter(({ col }) => col.key === "description").map(({ c }) => c.text.trim()).join(" ");
        if (extra) prev.description = `${prev.description ?? ""} ${extra}`.trim();
        continue;
      }
      if (!hasNumber || !(line.description || line.sku)) {
        if (doc.lineItems.length > 0) break; // end of table
        continue;
      }
      doc.lineItems.push(line);
      prev = line;
    }
  }

  // 4. Map key/values onto the document.
  const numberKey: Record<DocType, KvKey> = {
    commercial_invoice: "invoiceNo", packing_list: "plNo", purchase_order: "poNo", bill_of_lading: "blNo",
    certificate_of_origin: "certNo", shipping_instruction: "siNo", other: "docNo",
  };
  doc.docNumber = kv.get(numberKey[type]) ?? kv.get("docNo") ?? null;
  if (type !== "purchase_order") doc.poNumber = kv.get("poNo") ?? null;
  if (type !== "commercial_invoice") doc.invoiceNumber = kv.get("invoiceNo") ?? null;
  doc.docDate = normDate(kv.get("date"));
  if (kv.get("date") && !doc.docDate) warnings.push(`Could not read the date “${kv.get("date")}”.`);
  const incoterm = kv.get("incoterm");
  if (incoterm) {
    const m = incoterm.match(/^([A-Za-z&]{3,4})\b\s*(.*)$/);
    doc.incoterm = m ? m[1].toUpperCase() : incoterm;
    doc.incotermPlace = m?.[2]?.replace(/incoterms?.*$/i, "").trim() || null;
  }
  const totalAmount = kv.get("totalAmount");
  doc.currency = normCurrency(kv.get("currency")) ?? (totalAmount ? normCurrency(totalAmount) : null);
  doc.paymentTerms = kv.get("paymentTerms") ?? null;
  doc.countryOfOrigin = kv.get("origin") ?? null;
  doc.portOfLoading = kv.get("pol") ?? null;
  doc.portOfDischarge = kv.get("pod") ?? null;
  doc.vesselVoyage = kv.get("vessel") ?? null;
  const containers = kv.get("containers");
  if (containers) doc.containerNumbers = containers.split(/[,;/\s]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z]{4}\d{6,7}$/.test(s));
  const num = (k: KvKey) => (kv.has(k) ? parseNumber(kv.get(k)!) : null);
  doc.totals.packages = num("totalPackages") ?? doc.totals.packages;
  doc.totals.grossWeightKg = num("totalGross") ?? doc.totals.grossWeightKg;
  doc.totals.netWeightKg = num("totalNet") ?? doc.totals.netWeightKg;
  doc.totals.volumeCbm = num("totalCbm") ?? doc.totals.volumeCbm;
  doc.totals.amount = num("totalAmount") ?? doc.totals.amount;
  doc.totals.quantity = num("totalQty") ?? doc.totals.quantity;
  if (doc.lineItems.length > 0 && doc.totals.quantity == null && type !== "bill_of_lading") {
    // Leave totals.quantity null: only compare what is printed.
  }

  // 5. Confidence = coverage of what this document type should carry.
  let found = 0;
  let expected = 0;
  const expect = (ok: boolean, weight = 1) => {
    expected += weight;
    if (ok) found += weight;
  };
  expect(sure, 2);
  expect(!!doc.docNumber);
  expect(!!doc.docDate, 0.5);
  expect(!!doc.shipper.name, 1.5);
  expect(!!doc.consignee.name, 1.5);
  if (type !== "bill_of_lading") expect(doc.lineItems.length > 0, 3);
  else expect(doc.totals.packages != null || doc.totals.grossWeightKg != null, 2);
  if (type === "commercial_invoice" || type === "purchase_order") expect(doc.totals.amount != null || doc.lineItems.some((l) => l.amount != null));
  const confidence = Math.min(0.95, Math.round((found / expected) * 100) / 100);
  if (!sure) warnings.push("Document type was inferred from weak signals — please confirm it.");
  if (type !== "bill_of_lading" && doc.lineItems.length === 0) warnings.push("No line-item table was recognised.");

  return { document: doc, method: "layout-parser", confidence, warnings };
}

function findBelow(rows: Row[], ri: number, cell: Cell, tolerance: number): Cell | undefined {
  const next = rows[ri + 1];
  return next?.cells.find((c) => Math.abs(c.x0 - cell.x0) <= tolerance);
}

function hasParty(p: Party): boolean {
  return !!p.name;
}

const TAX_ID = /^(tax\s*id|vat(\s*no\.?)?|ein|iec|gstin|trn|eori|tin|cnpj|abn|uen|mst|org\.?\s*no)\b[:\s]*/i;

export function toParty(lines: string[]): Party {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  const party: Party = { name: null, address: null, country: null, taxId: null };
  if (cleaned.length === 0) return party;
  const rest: string[] = [];
  for (const l of cleaned.slice(1)) {
    if (TAX_ID.test(l)) party.taxId = l.replace(/^tax\s*id[:\s]*/i, "").trim();
    else rest.push(l);
  }
  party.name = cleaned[0];
  // A line ending in a comma was soft-wrapped; otherwise each line is an address part.
  const addr = rest.reduce((acc, l) => (!acc ? l : acc.endsWith(",") ? `${acc} ${l}` : `${acc}, ${l}`), "");
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && isCountryWord(last)) {
    party.country = last;
    parts.pop();
  }
  party.address = parts.join(", ") || null;
  return party;
}

/**
 * Normalisation helpers. Trade documents describe the same facts in wildly
 * different ways ("PCS" vs "pieces", "Hamburg, DE" vs "DEHAM", "GmbH" vs
 * "G.m.b.H."). Everything here exists so that comparisons fail only on real
 * differences, never on formatting.
 */

const STOP_WORDS = new Set([
  "the", "and", "of", "for", "with", "a", "an", "in", "to", "by", "per", "x",
]);

/** Legal-form suffixes that should not make two company names differ. */
const LEGAL_FORMS = new Set([
  "ltd", "limited", "llc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "gmbh", "ag", "kg", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "plc", "pvt", "private",
  "pte", "pty", "oy", "ab", "as", "aps", "kk", "sl", "lda", "jsc", "llp", "sdn", "bhd", "tbk", "fze", "fzco",
]);

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  st: "street", str: "strasse", straße: "strasse", rd: "road", ave: "avenue", av: "avenue",
  blvd: "boulevard", bldg: "building", fl: "floor", flr: "floor", ste: "suite", no: "number",
  nr: "number", ind: "industrial", est: "estate", dist: "district", hwy: "highway", ln: "lane",
  dr: "drive", sq: "square", pk: "park", ctr: "centre", center: "centre",
};

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function normText(s: string | null | undefined): string {
  if (!s) return "";
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(s: string | null | undefined, opts: { dropStop?: boolean } = {}): string[] {
  const t = normText(s).split(" ").filter(Boolean);
  return opts.dropStop ? t.filter((w) => !STOP_WORDS.has(w)) : t;
}

/** Company name reduced to its distinctive tokens. "ACME Trading GmbH." -> "acme trading" */
export function normCompany(s: string | null | undefined): string {
  return tokens(s)
    .map((w) => w.replace(/\./g, ""))
    .filter((w) => !LEGAL_FORMS.has(w))
    .join(" ");
}

export function normAddress(s: string | null | undefined): string {
  return tokens(s)
    .map((w) => ADDRESS_ABBREVIATIONS[w] ?? w)
    .join(" ");
}

/** Reference numbers: case-insensitive, ignore separators. "PO-2024/0012" == "po 2024 0012" */
export function normRef(s: string | null | undefined): string {
  if (!s) return "";
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Character trigram set for fuzzy matching. */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient on character trigrams, 0..1. Robust to typos and word order. */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normText(a);
  const nb = normText(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Token-set overlap, 0..1 — insensitive to word order and extra words. */
export function tokenOverlap(a: string | null | undefined, b: string | null | undefined): number {
  const ta = new Set(tokens(a, { dropStop: true }));
  const tb = new Set(tokens(b, { dropStop: true }));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/** Blend of trigram similarity and token containment for product descriptions. */
export function descriptionSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return Math.max(similarity(a, b), 0.5 * similarity(a, b) + 0.5 * tokenOverlap(a, b));
}

export function sameCompany(a: string | null, b: string | null): number {
  const na = normCompany(a);
  const nb = normCompany(b);
  if (!na || !nb) return na === nb ? 1 : 0;
  if (na === nb) return 1;
  return similarity(na, nb);
}

export function sameAddress(a: string | null, b: string | null): number {
  const na = normAddress(a);
  const nb = normAddress(b);
  if (!na || !nb) return na === nb ? 1 : 0;
  if (na === nb) return 1;
  // Numbers in addresses (street no., postcode) must match exactly.
  const numsA = na.match(/\d+/g)?.join(" ") ?? "";
  const numsB = nb.match(/\d+/g)?.join(" ") ?? "";
  const base = Math.max(similarity(na, nb), tokenOverlap(na, nb));
  return numsA === numsB ? base : Math.min(base, 0.6);
}

// ------------------------------------------------------------------ Units ---

const UNIT_ALIASES: Record<string, string> = {
  pc: "pcs", pcs: "pcs", piece: "pcs", pieces: "pcs", ea: "pcs", each: "pcs", unit: "pcs", units: "pcs",
  nos: "pcs", no: "pcs", nr: "pcs", stk: "pcs", st: "pcs", u: "pcs",
  set: "set", sets: "set",
  pr: "pair", pair: "pair", pairs: "pair", prs: "pair",
  dz: "dozen", doz: "dozen", dozen: "dozen",
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  g: "g", gr: "g", gram: "g", grams: "g",
  t: "t", mt: "t", ton: "t", tons: "t", tonne: "t", tonnes: "t",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  m: "m", mtr: "m", mtrs: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  l: "l", ltr: "l", litre: "l", liter: "l", litres: "l", liters: "l",
  ctn: "ctn", ctns: "ctn", carton: "ctn", cartons: "ctn", box: "ctn", boxes: "ctn",
  roll: "roll", rolls: "roll", bag: "bag", bags: "bag", drum: "drum", drums: "drum",
  plt: "pallet", pallet: "pallet", pallets: "pallet",
};

/** Conversion to a base unit within the same dimension. */
const UNIT_FACTORS: Record<string, { base: string; factor: number }> = {
  pcs: { base: "pcs", factor: 1 },
  pair: { base: "pcs", factor: 2 },
  dozen: { base: "pcs", factor: 12 },
  kg: { base: "kg", factor: 1 },
  g: { base: "kg", factor: 0.001 },
  t: { base: "kg", factor: 1000 },
  lb: { base: "kg", factor: 0.45359237 },
};

export function normUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const k = normText(u).replace(/\s/g, "");
  return UNIT_ALIASES[k] ?? k;
}

/**
 * Express a quantity in a base unit so "10 dozen" and "120 pcs" compare equal.
 * Unknown units are returned as-is (base = the unit itself, factor 1).
 */
export function toBaseQuantity(qty: number | null, unit: string | null): { qty: number | null; unit: string | null } {
  if (qty == null) return { qty: null, unit: normUnit(unit) };
  const n = normUnit(unit);
  if (!n) return { qty, unit: null };
  const f = UNIT_FACTORS[n];
  return f ? { qty: round(qty * f.factor, 6), unit: f.base } : { qty, unit: n };
}

export function unitsCompatible(a: string | null, b: string | null): boolean {
  const ua = toBaseQuantity(1, a).unit;
  const ub = toBaseQuantity(1, b).unit;
  if (!ua || !ub) return true; // unknown unit on one side: compare raw numbers
  return ua === ub;
}

// ---------------------------------------------------------------- Numbers ---

export function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Parse human numbers in either convention: "1,234.50", "1.234,50", "1 234,5",
 * "USD 12,000", "(150.00)" (negative).
 */
export function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal mark.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    const commaCount = (s.match(/,/g) ?? []).length;
    // "1,234" (thousands) vs "12,5" (decimal)
    s = commaCount === 1 && decimals !== 3 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1) {
    const dotCount = (s.match(/\./g) ?? []).length;
    if (dotCount > 1) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

export function withinTolerance(a: number, b: number, rel: number, abs = 0.005): boolean {
  return Math.abs(a - b) <= abs || relDiff(a, b) <= rel;
}

export function fmtNumber(n: number | null | undefined, dp?: number): string {
  if (n == null) return "—";
  const decimals = dp ?? (Number.isInteger(n) ? 0 : 2);
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtMoney(n: number | null | undefined, currency?: string | null): string {
  if (n == null) return "—";
  const body = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${body}` : body;
}

// ----------------------------------------------------------------- Codes ---

/** HS code digits only. "8471.30.01" -> "84713001" */
export function normHs(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

export function isValidHs(s: string | null | undefined): boolean {
  const d = normHs(s);
  return d.length >= 6 && d.length <= 10 && d.length % 2 === 0;
}

export const INCOTERMS_2020 = ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"] as const;
const LEGACY_INCOTERMS = ["DAT", "DDU", "DAF", "DES", "DEQ", "C&F", "CNF"];

export function normIncoterm(s: string | null | undefined): string | null {
  if (!s) return null;
  const up = s.toUpperCase().replace(/\s+/g, " ").trim();
  const m = up.match(/\b(EXW|FCA|CPT|CIP|DAP|DPU|DDP|FAS|FOB|CFR|CIF|DAT|DDU|DAF|DES|DEQ|CNF|C&F|C AND F)\b/);
  if (!m) return up.slice(0, 3);
  if (m[1] === "CNF" || m[1] === "C&F" || m[1] === "C AND F") return "CFR";
  return m[1];
}

export function incotermStatus(s: string | null | undefined): "valid" | "legacy" | "unknown" {
  // "C&F" / "CNF" are trade slang for CFR but not Incoterms — banks reject them under UCP 600.
  if (s && /\b(C\s?&\s?F|CNF|C AND F)\b/i.test(s)) return "legacy";
  const n = normIncoterm(s);
  if (!n) return "unknown";
  if ((INCOTERMS_2020 as readonly string[]).includes(n)) return "valid";
  if (LEGACY_INCOTERMS.includes(n)) return "legacy";
  return "unknown";
}

const CURRENCY_ALIASES: Record<string, string> = {
  $: "USD", us$: "USD", usd: "USD", "us dollar": "USD", "us dollars": "USD", dollars: "USD",
  "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR",
  "£": "GBP", gbp: "GBP", "¥": "JPY", jpy: "JPY", rmb: "CNY", cny: "CNY", yuan: "CNY",
  inr: "INR", rs: "INR", "₹": "INR", aed: "AED", sgd: "SGD", hkd: "HKD", chf: "CHF", cad: "CAD", aud: "AUD",
  vnd: "VND", thb: "THB", myr: "MYR", idr: "IDR", krw: "KRW", brl: "BRL", mxn: "MXN", try: "TRY", zar: "ZAR",
};

export function normCurrency(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = s.trim().toLowerCase();
  if (CURRENCY_ALIASES[k]) return CURRENCY_ALIASES[k];
  const m = s.toUpperCase().match(/\b[A-Z]{3}\b/);
  return m ? m[0] : null;
}

const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", "united states of america": "US", america: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", gb: "GB", england: "GB",
  germany: "DE", deutschland: "DE", de: "DE", france: "FR", fr: "FR", italy: "IT", it: "IT",
  spain: "ES", es: "ES", netherlands: "NL", holland: "NL", nl: "NL", belgium: "BE", be: "BE",
  china: "CN", prc: "CN", "peoples republic of china": "CN", cn: "CN", "hong kong": "HK", hk: "HK",
  india: "IN", in: "IN", vietnam: "VN", "viet nam": "VN", vn: "VN", japan: "JP", jp: "JP",
  "south korea": "KR", korea: "KR", "republic of korea": "KR", kr: "KR", taiwan: "TW", tw: "TW",
  thailand: "TH", th: "TH", malaysia: "MY", my: "MY", indonesia: "ID", id: "ID", singapore: "SG", sg: "SG",
  bangladesh: "BD", bd: "BD", pakistan: "PK", pk: "PK", "sri lanka": "LK", lk: "LK", turkey: "TR", turkiye: "TR", tr: "TR",
  "united arab emirates": "AE", uae: "AE", ae: "AE", "saudi arabia": "SA", canada: "CA", ca: "CA",
  mexico: "MX", mx: "MX", brazil: "BR", br: "BR", australia: "AU", au: "AU", "new zealand": "NZ",
  "south africa": "ZA", za: "ZA", poland: "PL", portugal: "PT", sweden: "SE", denmark: "DK", norway: "NO",
  switzerland: "CH", ch: "CH", austria: "AT", ireland: "IE", egypt: "EG", kenya: "KE", nigeria: "NG", chile: "CL",
};

/** True when a word (or phrase) is just a country name or code, e.g. "UAE", "India". */
export function isCountryWord(s: string): boolean {
  const k = normText(s);
  return k.length > 1 && k in COUNTRY_ALIASES;
}

export function normCountry(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = normText(s);
  if (COUNTRY_ALIASES[k]) return COUNTRY_ALIASES[k];
  // "Made in China" / "Origin: Viet Nam"
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
    if (name.length > 3 && k.includes(name)) return code;
  }
  return s.trim().length === 2 ? s.trim().toUpperCase() : s.trim().toUpperCase();
}

/**
 * ISO 6346 container number validation, including the check digit.
 * "MSCU1234565" -> valid if the 11th digit matches the computed check digit.
 */
export function containerCheck(raw: string): { normalized: string; valid: boolean; reason?: string } {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(s)) {
    return { normalized: s, valid: false, reason: "Expected 4 letters (ending U, J or Z) followed by 7 digits" };
  }
  const letterValues: Record<string, number> = {};
  let v = 10;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++; // skip multiples of 11
    letterValues[ch] = v++;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const val = /\d/.test(ch) ? Number(ch) : letterValues[ch];
    sum += val * 2 ** i;
  }
  const check = (sum % 11) % 10;
  const valid = check === Number(s[10]);
  return valid ? { normalized: s, valid } : { normalized: s, valid, reason: `Check digit should be ${check}` };
}

/** Parse a date in common document formats into yyyy-mm-dd. */
export function normDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})/);
  if (m) {
    const mi = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(yr(+m[3]), mi + 1, +m[1]);
  }
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (m) {
    const mi = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(yr(+m[3]), mi + 1, +m[2]);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    // Trade paperwork is predominantly day-first; fall back to month-first only when impossible.
    const a = +m[1];
    const b = +m[2];
    if (a > 12) return iso(yr(+m[3]), b, a);
    if (b > 12) return iso(yr(+m[3]), a, b);
    return iso(yr(+m[3]), b, a);
  }
  return null;
}

function yr(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

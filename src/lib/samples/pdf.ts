import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DOC_TYPE_LABEL, type ExtractedDocument, type Party } from "@/lib/domain/types";
import { fmtNumber } from "@/lib/engine/normalize";

/**
 * Renders an ExtractedDocument as a realistic trade-document PDF. Used to
 * produce the downloadable sample packs, so the full upload → extract →
 * reconcile pipeline can be exercised on genuine PDF files.
 */

const A4: [number, number] = [595.28, 841.89];
const M = 36; // page margin
const INK = rgb(0.08, 0.1, 0.14);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.78, 0.8, 0.84);

interface Col {
  key: string;
  title: string;
  width: number;
  align?: "left" | "right";
  get: (l: ExtractedDocument["lineItems"][number], i: number) => string;
}

function money(n: number | null): string {
  return n == null ? "" : fmtNumber(n, 2);
}

function columnsFor(doc: ExtractedDocument): Col[] {
  const no: Col = { key: "no", title: "No.", width: 24, get: (l, i) => String(l.lineNo ?? i + 1) };
  const sku: Col = { key: "sku", title: "Item Code", width: 74, get: (l) => l.sku ?? "" };
  const hs: Col = { key: "hs", title: "HS Code", width: 56, get: (l) => l.hsCode ?? "" };
  const qty: Col = { key: "qty", title: "Qty", width: 44, align: "right", get: (l) => (l.quantity == null ? "" : fmtNumber(l.quantity)) };
  const unit: Col = { key: "unit", title: "Unit", width: 30, get: (l) => l.unit ?? "" };
  if (doc.docType === "packing_list") {
    return [
      no, sku, { key: "desc", title: "Description of Goods", width: 152, get: (l) => l.description ?? "" }, hs, qty, unit,
      { key: "pkgs", title: "Pkgs", width: 32, align: "right", get: (l) => (l.packages == null ? "" : fmtNumber(l.packages)) },
      { key: "nw", title: "N.W. (kg)", width: 50, align: "right", get: (l) => money(l.netWeightKg) },
      { key: "gw", title: "G.W. (kg)", width: 50, align: "right", get: (l) => money(l.grossWeightKg) },
    ];
  }
  if (doc.docType === "certificate_of_origin") {
    return [no, sku, { key: "desc", title: "Description of Goods", width: 240, get: (l) => l.description ?? "" }, hs, qty, unit,
      { key: "pkgs", title: "Pkgs", width: 40, align: "right", get: (l) => (l.packages == null ? "" : fmtNumber(l.packages)) }];
  }
  const showHs = doc.lineItems.some((l) => l.hsCode);
  return [
    no, sku, { key: "desc", title: "Description of Goods", width: showHs ? 166 : 222, get: (l) => l.description ?? "" },
    ...(showHs ? [hs] : []), qty, unit,
    { key: "price", title: "Unit Price", width: 52, align: "right", get: (l) => money(l.unitPrice) },
    { key: "amount", title: "Amount", width: 60, align: "right", get: (l) => money(l.amount) },
  ];
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function partyBlock(page: PDFPage, font: PDFFont, bold: PDFFont, title: string, p: Party, x: number, y: number, w: number): number {
  page.drawText(title, { x, y, size: 7, font: bold, color: MUTED });
  let yy = y - 12;
  if (p.name) {
    for (const ln of wrap(p.name, bold, 8.5, w)) {
      page.drawText(ln, { x, y: yy, size: 8.5, font: bold, color: INK });
      yy -= 11;
    }
  }
  // Pack address parts into lines; a trailing comma marks a soft line break.
  const parts = [p.address, p.country].filter((s): s is string => !!s && !!s.trim()).join(", ").split(/,\s*/);
  const addrLines: string[] = [];
  for (const part of parts) {
    const last = addrLines[addrLines.length - 1];
    if (last && font.widthOfTextAtSize(`${last}, ${part}`, 8) <= w) addrLines[addrLines.length - 1] = `${last}, ${part}`;
    else addrLines.push(part);
  }
  const withBreaks = addrLines.map((l, i) => (i < addrLines.length - 1 ? `${l},` : l));
  for (const ln of withBreaks.flatMap((l) => wrap(l, font, 8, w))) {
    page.drawText(ln, { x, y: yy, size: 8, font, color: INK });
    yy -= 10;
  }
  if (p.taxId) {
    page.drawText(`Tax ID: ${p.taxId}`, { x, y: yy, size: 7.5, font, color: MUTED });
    yy -= 10;
  }
  return yy;
}

export async function renderDocumentPdf(doc: ExtractedDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${DOC_TYPE_LABEL[doc.docType]} ${doc.docNumber ?? ""}`.trim());
  pdf.setProducer("Plimsoll sample generator");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage(A4);
  const W = A4[0] - 2 * M;
  let y = A4[1] - M;

  // Letterhead: issuer on the left, document title on the right.
  const issuer = doc.docType === "purchase_order" ? doc.consignee : doc.docType === "bill_of_lading" ? null : doc.shipper;
  if (issuer?.name) page.drawText(issuer.name, { x: M, y: y - 4, size: 11, font: bold, color: INK });
  if (doc.docType === "bill_of_lading") page.drawText("OCEAN CARRIER — NON-NEGOTIABLE DRAFT", { x: M, y: y - 4, size: 9, font: bold, color: MUTED });
  const title = DOC_TYPE_LABEL[doc.docType].toUpperCase();
  page.drawText(title, { x: M + W - bold.widthOfTextAtSize(title, 15), y: y - 6, size: 15, font: bold, color: INK });
  y -= 22;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1.2, color: INK });
  y -= 16;

  // Reference block (label: value pairs), two columns.
  const numberLabel: Record<string, string> = {
    commercial_invoice: "Invoice No", packing_list: "Packing List No", purchase_order: "PO Number",
    bill_of_lading: "B/L No", certificate_of_origin: "Certificate No", shipping_instruction: "SI No", other: "Document No",
  };
  const refs: [string, string | null][] = [
    [numberLabel[doc.docType], doc.docNumber],
    ["Date", doc.docDate],
    ...(doc.docType !== "purchase_order" ? ([["PO Number", doc.poNumber]] as [string, string | null][]) : []),
    ...(doc.docType !== "commercial_invoice" ? ([["Invoice No", doc.invoiceNumber]] as [string, string | null][]) : []),
    ["Currency", doc.currency],
    ["Incoterms", doc.incoterm ? [doc.incoterm, doc.incotermPlace].filter(Boolean).join(" ") : null],
    ["Payment Terms", doc.paymentTerms],
    ["Country of Origin", doc.countryOfOrigin],
  ];
  const visibleRefs = refs.filter(([, v]) => v);
  const half = Math.ceil(visibleRefs.length / 2);
  visibleRefs.forEach(([k, v], i) => {
    const col = i < half ? 0 : 1;
    const row = i < half ? i : i - half;
    page.drawText(`${k}: ${v}`, { x: M + col * (W / 2), y: y - row * 12, size: 8.5, font, color: INK });
  });
  y -= half * 12 + 10;

  // Parties.
  const colW = (W - 24) / 3;
  const shipperTitle = doc.docType === "purchase_order" ? "SUPPLIER / SELLER" : "SHIPPER / EXPORTER";
  const consigneeTitle = doc.docType === "purchase_order" ? "BUYER / SHIP TO" : "CONSIGNEE";
  const y1 = partyBlock(page, font, bold, shipperTitle, doc.shipper, M, y, colW);
  const y2 = partyBlock(page, font, bold, consigneeTitle, doc.consignee, M + colW + 12, y, colW);
  const y3 = doc.notifyParty.name ? partyBlock(page, font, bold, "NOTIFY PARTY", doc.notifyParty, M + 2 * (colW + 12), y, colW) : y;
  y = Math.min(y1, y2, y3) - 8;

  // Logistics.
  const logi: [string, string | null][] = [
    ["Port of Loading", doc.portOfLoading],
    ["Port of Discharge", doc.portOfDischarge],
    ["Vessel / Voyage", doc.vesselVoyage],
    ["Container No(s)", doc.containerNumbers.length ? doc.containerNumbers.join(", ") : null],
  ];
  const visibleLogi = logi.filter(([, v]) => v);
  if (visibleLogi.length) {
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + W, y: y + 4 }, thickness: 0.5, color: RULE });
    y -= 8;
    visibleLogi.forEach(([k, v], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      page.drawText(`${k}: ${v}`, { x: M + col * (W / 2), y: y - row * 12, size: 8.5, font, color: INK });
    });
    y -= Math.ceil(visibleLogi.length / 2) * 12 + 10;
  }

  // Line items table.
  if (doc.lineItems.length > 0) {
    const cols = columnsFor(doc);
    const scale = W / cols.reduce((a, c) => a + c.width, 0);
    cols.forEach((c) => (c.width *= scale));
    page.drawRectangle({ x: M, y: y - 4, width: W, height: 16, color: rgb(0.93, 0.94, 0.95) });
    let x = M;
    for (const c of cols) {
      const tw = bold.widthOfTextAtSize(c.title, 7.5);
      page.drawText(c.title, { x: c.align === "right" ? x + c.width - tw - 3 : x + 3, y: y + 1, size: 7.5, font: bold, color: INK });
      x += c.width;
    }
    y -= 18;
    doc.lineItems.forEach((l, i) => {
      const descCol = cols.find((c) => c.key === "desc")!;
      const descLines = wrap(descCol.get(l, i), font, 7.5, descCol.width - 6);
      let cx = M;
      for (const c of cols) {
        if (c.key === "desc") {
          descLines.forEach((dl, j) => page.drawText(dl, { x: cx + 3, y: y - j * 9.5, size: 7.5, font, color: INK }));
        } else {
          const t = c.get(l, i);
          const tw = font.widthOfTextAtSize(t, 7.5);
          page.drawText(t, { x: c.align === "right" ? cx + c.width - tw - 3 : cx + 3, y, size: 7.5, font, color: INK });
        }
        cx += c.width;
      }
      y -= Math.max(1, descLines.length) * 9.5 + 5;
      page.drawLine({ start: { x: M, y: y + 6 }, end: { x: M + W, y: y + 6 }, thickness: 0.3, color: RULE });
    });
    // Totals row aligned to the numeric columns.
    const totalsByKey: Record<string, string> = {
      qty: doc.totals.quantity == null ? "" : fmtNumber(doc.totals.quantity),
      pkgs: doc.totals.packages == null ? "" : fmtNumber(doc.totals.packages),
      nw: money(doc.totals.netWeightKg),
      gw: money(doc.totals.grossWeightKg),
      amount: money(doc.totals.amount),
    };
    let tx = M;
    page.drawText("TOTAL", { x: M + 3, y: y - 2, size: 8, font: bold, color: INK });
    for (const c of cols) {
      const t = totalsByKey[c.key];
      if (t) {
        const tw = bold.widthOfTextAtSize(t, 8);
        page.drawText(t, { x: tx + c.width - tw - 3, y: y - 2, size: 8, font: bold, color: INK });
      }
      tx += c.width;
    }
    y -= 22;
  }

  // Summary block (shipping figures), always present when known.
  const summary: [string, string | null][] = [
    ["Total Packages", doc.totals.packages == null ? null : fmtNumber(doc.totals.packages)],
    ["Total Net Weight (kg)", doc.lineItems.length ? null : money(doc.totals.netWeightKg) || null],
    ["Total Gross Weight (kg)", money(doc.totals.grossWeightKg) || null],
    ["Total Measurement (CBM)", doc.totals.volumeCbm == null ? null : fmtNumber(doc.totals.volumeCbm, 2)],
    ...(doc.docType === "commercial_invoice" || doc.docType === "purchase_order"
      ? ([["Total Amount", doc.totals.amount == null ? null : `${doc.currency ?? ""} ${money(doc.totals.amount)}`.trim()]] as [string, string | null][])
      : []),
  ];
  const visibleSummary = summary.filter(([, v]) => v);
  if (doc.docType === "bill_of_lading") {
    page.drawText("Description of Goods: SAID TO CONTAIN — see attached commercial invoice", { x: M, y, size: 8.5, font, color: INK });
    y -= 14;
  }
  visibleSummary.forEach(([k, v], i) => {
    page.drawText(`${k}: ${v}`, { x: M + (i % 2) * (W / 2), y: y - Math.floor(i / 2) * 12, size: 8.5, font: i === visibleSummary.length - 1 && k === "Total Amount" ? bold : font, color: INK });
  });
  y -= Math.ceil(visibleSummary.length / 2) * 12 + 18;

  // Footer declaration.
  const decl =
    doc.docType === "commercial_invoice"
      ? "We hereby certify that this invoice shows the actual price of the goods described, that all particulars are true and correct."
      : doc.docType === "certificate_of_origin"
        ? "It is hereby certified that the goods described above originate in the country shown."
        : doc.docType === "bill_of_lading"
          ? "Shipped on board in apparent good order and condition unless otherwise stated. Draft for approval — not valid for release."
          : "Authorised signature";
  for (const ln of wrap(decl, font, 7, W)) {
    page.drawText(ln, { x: M, y, size: 7, font, color: MUTED });
    y -= 9;
  }
  page.drawText("Generated sample document — Plimsoll", { x: M, y: M - 12, size: 6.5, font, color: MUTED });

  return pdf.save();
}

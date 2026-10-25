import { emptyDocument, emptyLine, type DocType, type ExtractedDocument, type LineItem, type Party } from "@/lib/domain/types";

/**
 * Sample document packs modelled on real export shipments. They are used for
 * the "try a sample" flow, the seeded demo workspace, the generated sample
 * PDFs in /public/samples and the engine's regression tests.
 */

/** Append a valid ISO 6346 check digit to a 10-character container prefix. */
export function withCheckDigit(prefix10: string): string {
  const letterValues: Record<string, number> = {};
  let v = 10;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++;
    letterValues[ch] = v++;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = prefix10[i];
    sum += (/\d/.test(ch) ? Number(ch) : letterValues[ch]) * 2 ** i;
  }
  return `${prefix10}${(sum % 11) % 10}`;
}

function party(name: string, address: string, country: string, taxId: string | null = null): Party {
  return { name, address, country, taxId };
}

function line(p: Partial<LineItem>): LineItem {
  return { ...emptyLine(), ...p };
}

type DocInput = Omit<Partial<ExtractedDocument>, "totals"> & { totals?: Partial<ExtractedDocument["totals"]> };

function doc(docType: DocType, p: DocInput): ExtractedDocument {
  const base = emptyDocument(docType);
  return { ...base, ...p, totals: { ...base.totals, ...(p.totals ?? {}) } };
}

export interface SamplePack {
  slug: string;
  name: string;
  reference: string;
  route: string;
  story: string;
  documents: { fileName: string; document: ExtractedDocument }[];
}

// --------------------------------------------------------------------------
// 1. Saigon Craft Furniture → Nordic Home Supplies (several planted problems)
// --------------------------------------------------------------------------

const SCF = party("Saigon Craft Furniture Co., Ltd.", "Lot C7, Tan Thuan Export Processing Zone, District 7, Ho Chi Minh City", "Vietnam", "0312874451");
const NHS = party("Nordic Home Supplies AB", "Lagergatan 14, 415 05 Gothenburg", "Sweden", "SE556712345601");
const NHS_BROKER = party("Kustlinjen Customs Brokers AB", "Hamngatan 2, 411 06 Gothenburg", "Sweden");
const C1 = withCheckDigit("MSKU738201");
const C2 = withCheckDigit("MSKU738215");
const C2_TYPO = C2.slice(0, 10) + String((Number(C2[10]) + 3) % 10); // transposed digit on the packing list

const furnitureLines = {
  inv: [
    line({ lineNo: 1, sku: "SCF-OAK-DT180", description: "Solid oak dining table 180x90cm, natural oil finish", hsCode: "9403.60.10", quantity: 120, unit: "PCS", unitPrice: 214.0, amount: 25680.0, netWeightKg: 4560, grossWeightKg: 5160, packages: 120 }),
    line({ lineNo: 2, sku: "SCF-OAK-CH01", description: "Oak dining chair with woven rattan seat", hsCode: "9401.61.00", quantity: 480, unit: "PCS", unitPrice: 46.5, amount: 22320.0, netWeightKg: 3360, grossWeightKg: 3840, packages: 240 }),
    line({ lineNo: 3, sku: "SCF-ACA-SB160", description: "Acacia wood sideboard 160cm, 3 doors", hsCode: "9403.60.90", quantity: 60, unit: "PCS", unitPrice: 189.0, amount: 11340.0, netWeightKg: 2700, grossWeightKg: 3060, packages: 60 }),
    line({ lineNo: 4, sku: "SCF-RAT-LMP", description: "Hand-woven rattan pendant lamp shade 45cm", hsCode: "9405.91.90", quantity: 240, unit: "PCS", unitPrice: 18.75, amount: 4500.0, netWeightKg: 360, grossWeightKg: 480, packages: 40 }),
  ],
};

const furnitureInvoice = doc("commercial_invoice", {
  docNumber: "SCF-INV-24117", docDate: "2026-09-18", currency: "USD", incoterm: "FOB", incotermPlace: "Ho Chi Minh City",
  poNumber: "NHS-PO-88231", shipper: SCF, consignee: NHS, notifyParty: NHS_BROKER,
  portOfLoading: "Cat Lai, Ho Chi Minh City", portOfDischarge: "Gothenburg", vesselVoyage: "MAERSK KOWLOON 438W",
  containerNumbers: [C1, C2], countryOfOrigin: "Vietnam", paymentTerms: "30% T/T deposit, 70% against B/L copy",
  lineItems: furnitureLines.inv,
  totals: { quantity: 900, amount: 63840.0, netWeightKg: 10980, grossWeightKg: 12540, packages: 460, volumeCbm: 56.2 },
});

const furniturePL = doc("packing_list", {
  docNumber: "SCF-PL-24117", docDate: "2026-09-18", invoiceNumber: "SCF-INV-24117", poNumber: "NHS-PO-88231",
  shipper: SCF, consignee: NHS, portOfLoading: "Cat Lai, Ho Chi Minh City", portOfDischarge: "Gothenburg",
  vesselVoyage: "MAERSK KOWLOON 438W", containerNumbers: [C1, C2_TYPO], countryOfOrigin: "Vietnam",
  lineItems: [
    line({ lineNo: 1, sku: "SCF-OAK-DT180", description: "Solid oak dining table 180x90cm, natural oil finish", hsCode: "9403.60.10", quantity: 120, unit: "PCS", netWeightKg: 4560, grossWeightKg: 5160, packages: 120 }),
    // Planted: 20 chairs short-packed versus the invoice.
    line({ lineNo: 2, sku: "SCF-OAK-CH01", description: "Oak dining chair with woven rattan seat", hsCode: "9401.61.00", quantity: 460, unit: "PCS", netWeightKg: 3220, grossWeightKg: 3680, packages: 230 }),
    // Planted: HS heading differs (9403.60 furniture vs 9403.40 kitchen furniture).
    line({ lineNo: 3, sku: "SCF-ACA-SB160", description: "Acacia wood sideboard 160cm, 3 doors", hsCode: "9403.40.00", quantity: 60, unit: "PCS", netWeightKg: 2700, grossWeightKg: 3060, packages: 60 }),
    line({ lineNo: 4, sku: "SCF-RAT-LMP", description: "Rattan lamp shades, assorted", hsCode: "9405.91.90", quantity: 240, unit: "PCS", netWeightKg: 360, grossWeightKg: 480, packages: 40 }),
  ],
  totals: { quantity: 880, netWeightKg: 10840, grossWeightKg: 12380, packages: 450, volumeCbm: 56.2 },
});

const furniturePO = doc("purchase_order", {
  docNumber: "NHS-PO-88231", docDate: "2026-07-02", currency: "USD", incoterm: "FOB", incotermPlace: "Ho Chi Minh City",
  shipper: party("Saigon Craft Furniture Co., Ltd.", "Lot C7, Tan Thuan EPZ, District 7, Ho Chi Minh City", "Vietnam"),
  consignee: NHS, paymentTerms: "30% deposit, balance against copy B/L",
  lineItems: [
    line({ lineNo: 10, sku: "SCF-OAK-DT180", description: "Oak dining table 180 x 90 cm, oiled", quantity: 120, unit: "PCS", unitPrice: 214.0, amount: 25680.0 }),
    // Planted: the PO agreed USD 44.00 per chair; the invoice charges 46.50.
    line({ lineNo: 20, sku: "SCF-OAK-CH01", description: "Oak dining chair, rattan seat", quantity: 480, unit: "PCS", unitPrice: 44.0, amount: 21120.0 }),
    line({ lineNo: 30, sku: "SCF-ACA-SB160", description: "Acacia sideboard 160 cm", quantity: 60, unit: "PCS", unitPrice: 189.0, amount: 11340.0 }),
    line({ lineNo: 40, sku: "SCF-RAT-LMP", description: "Rattan pendant lamp shade 45 cm", quantity: 240, unit: "PCS", unitPrice: 18.75, amount: 4500.0 }),
    // Not in this shipment — backordered.
    line({ lineNo: 50, sku: "SCF-TEA-BN80", description: "Teak garden bench 80cm", quantity: 40, unit: "PCS", unitPrice: 96.0, amount: 3840.0 }),
  ],
  totals: { quantity: 940, amount: 66480.0 },
});

const furnitureBL = doc("bill_of_lading", {
  docNumber: "MAEU254118733", docDate: "2026-09-21",
  // Planted: the forwarder re-used another buyer's template for the consignee.
  shipper: SCF, consignee: party("Nordhem Interiors AB", "Industrivägen 9, 432 32 Varberg", "Sweden"),
  notifyParty: NHS_BROKER, invoiceNumber: "SCF-INV-24117",
  portOfLoading: "VNCLI Cat Lai", portOfDischarge: "SEGOT Gothenburg", vesselVoyage: "MAERSK KOWLOON / 438W",
  containerNumbers: [C1, C2],
  lineItems: [],
  totals: { packages: 460, grossWeightKg: 12540, volumeCbm: 56.2 },
});

// --------------------------------------------------------------------------
// 2. Indian home textiles → German retailer (clean pack)
// --------------------------------------------------------------------------

const JTX = party("Jaipur Textile Exports Pvt. Ltd.", "Plot 41, Sitapura Industrial Area, Jaipur, Rajasthan 302022", "India", "IEC 0815012345");
const HKG = party("Haus & Kissen GmbH", "Speicherstraße 8, 20457 Hamburg", "Germany", "DE298765432");
const C3 = withCheckDigit("HLXU501734");

const textileLines: LineItem[] = [
  line({ lineNo: 1, sku: "JTX-QC-200", description: "100% cotton block-printed quilt cover 200x200cm", hsCode: "6302.31.00", quantity: 1200, unit: "PCS", unitPrice: 14.2, amount: 17040.0, netWeightKg: 1680, grossWeightKg: 1860, packages: 60 }),
  line({ lineNo: 2, sku: "JTX-PC-5050", description: "100% cotton cushion cover 50x50cm, hand-embroidered", hsCode: "6304.92.00", quantity: 3000, unit: "PCS", unitPrice: 3.85, amount: 11550.0, netWeightKg: 600, grossWeightKg: 690, packages: 30 }),
  line({ lineNo: 3, sku: "JTX-TR-150", description: "Cotton table runner 150cm, indigo dabu print", hsCode: "6302.51.00", quantity: 1500, unit: "PCS", unitPrice: 4.1, amount: 6150.0, netWeightKg: 375, grossWeightKg: 420, packages: 15 }),
];

const textileInvoice = doc("commercial_invoice", {
  docNumber: "JTX/EXP/2026/0412", docDate: "2026-10-02", currency: "EUR", incoterm: "CIF", incotermPlace: "Hamburg",
  poNumber: "HK-4500021877", shipper: JTX, consignee: HKG, notifyParty: party("Same as consignee", "", "Germany"),
  portOfLoading: "Nhava Sheva (INNSA)", portOfDischarge: "Hamburg (DEHAM)", vesselVoyage: "HAPAG BERLIN EXPRESS 041E",
  containerNumbers: [C3], countryOfOrigin: "India", paymentTerms: "D/P at sight",
  lineItems: textileLines,
  totals: { quantity: 5700, amount: 34740.0, netWeightKg: 2655, grossWeightKg: 2970, packages: 105, volumeCbm: 24.8 },
});
const textilePL = doc("packing_list", {
  docNumber: "JTX/PL/2026/0412", docDate: "2026-10-02", invoiceNumber: "JTX/EXP/2026/0412", poNumber: "HK-4500021877",
  shipper: JTX, consignee: HKG, portOfLoading: "Nhava Sheva", portOfDischarge: "Hamburg", vesselVoyage: "HAPAG BERLIN EXPRESS 041E",
  containerNumbers: [C3], countryOfOrigin: "India",
  lineItems: textileLines.map((l) => ({ ...l, unitPrice: null, amount: null })),
  totals: { quantity: 5700, netWeightKg: 2655, grossWeightKg: 2970, packages: 105, volumeCbm: 24.8 },
});
const textilePO = doc("purchase_order", {
  docNumber: "HK-4500021877", docDate: "2026-08-11", currency: "EUR", incoterm: "CIF", incotermPlace: "Hamburg",
  shipper: JTX, consignee: HKG,
  lineItems: textileLines.map((l) => ({ ...l, netWeightKg: null, grossWeightKg: null, packages: null, hsCode: null })),
  totals: { quantity: 5700, amount: 34740.0 },
});
const textileBL = doc("bill_of_lading", {
  docNumber: "HLCUBO1261008841", docDate: "2026-10-05", shipper: JTX, consignee: HKG,
  notifyParty: party("Same as consignee", "", "Germany"), invoiceNumber: "JTX/EXP/2026/0412",
  portOfLoading: "INNSA Nhava Sheva", portOfDischarge: "DEHAM Hamburg", vesselVoyage: "BERLIN EXPRESS 041E",
  containerNumbers: [C3], totals: { packages: 105, grossWeightKg: 2970, volumeCbm: 24.8 },
});
const textileCOO = doc("certificate_of_origin", {
  docNumber: "COO-RJ-2026-118842", docDate: "2026-10-03", invoiceNumber: "JTX/EXP/2026/0412",
  shipper: JTX, consignee: HKG, countryOfOrigin: "India", portOfLoading: "Nhava Sheva", portOfDischarge: "Hamburg",
  lineItems: textileLines.map((l) => ({ ...l, unitPrice: null, amount: null, netWeightKg: null, grossWeightKg: null })),
  totals: { packages: 105, grossWeightKg: 2970 },
});

// --------------------------------------------------------------------------
// 3. Kerala spices → UAE distributor (arithmetic & compliance issues)
// --------------------------------------------------------------------------

const KSP = party("Malabar Spice Traders LLP", "Building 12/447, Mattancherry, Kochi, Kerala 682002", "India", "IEC 1013009988");
const DXB = party("Al Noor Foodstuff Trading LLC", "Warehouse 22, Al Qusais Industrial Area 2, Dubai", "United Arab Emirates", "TRN 100234567800003");
const C4 = withCheckDigit("CMAU442019");

const spiceInvLines: LineItem[] = [
  line({ lineNo: 1, sku: "MST-BP-550", description: "Black pepper whole, 550 GL, steam sterilised", hsCode: "0904.11.10", quantity: 8000, unit: "KG", unitPrice: 6.9, amount: 55200.0, netWeightKg: 8000, grossWeightKg: 8160, packages: 320 }),
  line({ lineNo: 2, sku: "MST-CAR-8MM", description: "Green cardamom 8mm bold", hsCode: "0908.31.10", quantity: 1500, unit: "KG", unitPrice: 24.5, amount: 36570.0, netWeightKg: 1500, grossWeightKg: 1560, packages: 60 }),
  line({ lineNo: 3, sku: "MST-TUR-FNG", description: "Turmeric fingers, Alleppey, double polished", hsCode: "910.30.20", quantity: 5000, unit: "KG", unitPrice: 2.15, amount: 10750.0, netWeightKg: 5000, grossWeightKg: 5100, packages: 200 }),
];

const spiceInvoice = doc("commercial_invoice", {
  docNumber: "MST-2026-0931", docDate: "2026-10-09", currency: "USD", incoterm: "C&F", incotermPlace: "Jebel Ali",
  poNumber: "ANF/PO/26/1187", shipper: KSP, consignee: DXB, notifyParty: DXB,
  portOfLoading: "Cochin (INCOK)", portOfDischarge: "Jebel Ali (AEJEA)", vesselVoyage: "CMA CGM TIGRIS 0FL3XW",
  containerNumbers: [C4], countryOfOrigin: "India", paymentTerms: "LC at sight",
  lineItems: spiceInvLines,
  totals: { quantity: 14500, amount: 102520.0, netWeightKg: 14500, grossWeightKg: 14820, packages: 580 },
});
const spicePL = doc("packing_list", {
  docNumber: "MST-PL-2026-0931", docDate: "2026-10-09", invoiceNumber: "MST-2026-0931", poNumber: "ANF/PO/26/1187",
  shipper: KSP, consignee: DXB, portOfLoading: "Cochin", portOfDischarge: "Jebel Ali", vesselVoyage: "CMA CGM TIGRIS 0FL3XW",
  containerNumbers: [C4], countryOfOrigin: "India",
  lineItems: [
    line({ lineNo: 1, sku: "MST-BP-550", description: "Black pepper whole 550 GL, steam sterilised, 25kg PP bags", hsCode: "0904.11.10", quantity: 8000, unit: "KGS", netWeightKg: 8000, grossWeightKg: 8160, packages: 320 }),
    line({ lineNo: 2, sku: "MST-CAR-8MM", description: "Green cardamom 8mm bold, 25kg jute bags", hsCode: "0908.31.10", quantity: 1500, unit: "KGS", netWeightKg: 1500, grossWeightKg: 1560, packages: 60 }),
    line({ lineNo: 3, sku: "MST-TUR-FNG", description: "Turmeric fingers double polished, 25kg PP bags", hsCode: "0910.30.20", quantity: 5000, unit: "KGS", netWeightKg: 5000, grossWeightKg: 5100, packages: 200 }),
  ],
  totals: { quantity: 14500, netWeightKg: 14500, grossWeightKg: 14820, packages: 580 },
});
const spiceBL = doc("bill_of_lading", {
  docNumber: "CMDUCOK0219334", docDate: "2026-10-12", shipper: KSP, consignee: party("To the order of Emirates NBD Bank PJSC", "Dubai", "United Arab Emirates"),
  notifyParty: DXB, portOfLoading: "Cochin, India", portOfDischarge: "Jebel Ali, UAE", vesselVoyage: "CMA CGM TIGRIS 0FL3XW",
  containerNumbers: [C4], totals: { packages: 580, grossWeightKg: 14820 },
});

export const SAMPLE_PACKS: SamplePack[] = [
  {
    slug: "saigon-furniture",
    name: "Oak & rattan furniture — FCL × 2",
    reference: "SCF-INV-24117",
    route: "Ho Chi Minh City → Gothenburg",
    story: "A Vietnamese furniture maker ships two containers to a Swedish retailer. The forwarder reused an old B/L template, the packing list was typed by hand and a price was renegotiated after the PO.",
    documents: [
      { fileName: "SCF-INV-24117 Commercial Invoice.pdf", document: furnitureInvoice },
      { fileName: "SCF-PL-24117 Packing List.pdf", document: furniturePL },
      { fileName: "NHS-PO-88231 Purchase Order.pdf", document: furniturePO },
      { fileName: "MAEU254118733 BL draft.pdf", document: furnitureBL },
    ],
  },
  {
    slug: "jaipur-textiles",
    name: "Block-printed home textiles — FCL",
    reference: "JTX/EXP/2026/0412",
    route: "Nhava Sheva → Hamburg",
    story: "A clean pack: invoice, packing list, PO, B/L and certificate of origin agree on every field. This is what “cleared to sail” looks like.",
    documents: [
      { fileName: "JTX-EXP-0412 Invoice.pdf", document: textileInvoice },
      { fileName: "JTX-PL-0412 Packing List.pdf", document: textilePL },
      { fileName: "HK-4500021877 PO.pdf", document: textilePO },
      { fileName: "HLCUBO1261008841 BL.pdf", document: textileBL },
      { fileName: "COO-RJ-2026-118842.pdf", document: textileCOO },
    ],
  },
  {
    slug: "malabar-spices",
    name: "Whole spices under L/C — FCL",
    reference: "MST-2026-0931",
    route: "Cochin → Jebel Ali",
    story: "Spices shipped under a letter of credit, where the bank rejects any discrepancy. An extension error, a dropped leading zero and a retired Incoterm hide in the invoice.",
    documents: [
      { fileName: "MST-2026-0931 Invoice.pdf", document: spiceInvoice },
      { fileName: "MST-PL-2026-0931.pdf", document: spicePL },
      { fileName: "CMDUCOK0219334 BL.pdf", document: spiceBL },
    ],
  },
];

export function getSample(slug: string): SamplePack | undefined {
  return SAMPLE_PACKS.find((s) => s.slug === slug);
}

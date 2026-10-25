import type { IssueCategory, Severity } from "@/lib/domain/types";

export interface RuleDef {
  id: string;
  name: string;
  category: IssueCategory;
  severity: Severity;
  /** Why the check exists — shown in the rules screen and in issue details. */
  why: string;
}

/**
 * The full catalogue of checks Plimsoll runs. Severity is the default; some
 * rules escalate or soften depending on which documents disagree.
 */
export const RULES: RuleDef[] = [
  // Parties
  { id: "party.consignee_name", name: "Consignee name matches", category: "party", severity: "blocker",
    why: "Carriers release cargo and customs files entries against the consignee named on the B/L and invoice. A different legal entity on any document is the single most common cause of a customs hold." },
  { id: "party.consignee_address", name: "Consignee address matches", category: "party", severity: "warning",
    why: "Address mismatches trigger manual review at destination and can misroute arrival notices." },
  { id: "party.shipper_name", name: "Shipper / exporter matches", category: "party", severity: "blocker",
    why: "The exporter of record must be identical across the invoice, packing list and B/L for export declarations and letters of credit." },
  { id: "party.shipper_address", name: "Shipper address matches", category: "party", severity: "advisory",
    why: "Minor address differences rarely block clearance but are flagged under L/C document examination." },
  { id: "party.notify", name: "Notify party matches", category: "party", severity: "advisory",
    why: "If the notify party differs the arrival notice may go to the wrong desk and free-time can lapse." },
  // References
  { id: "ref.po_number", name: "PO reference consistent", category: "reference", severity: "warning",
    why: "Buyers match payment against the PO number. A wrong reference delays payment and breaks three-way match." },
  { id: "ref.invoice_number", name: "Invoice reference consistent", category: "reference", severity: "warning",
    why: "The packing list and B/L must point to the invoice they accompany; customs brokers link them by number." },
  // Commercial
  { id: "commercial.currency", name: "Currency consistent", category: "value", severity: "blocker",
    why: "A currency mismatch between PO and invoice changes the declared customs value." },
  { id: "commercial.incoterm", name: "Incoterm consistent", category: "value", severity: "warning",
    why: "The Incoterm decides who pays freight and insurance and therefore the customs valuation basis." },
  { id: "commercial.total_value", name: "Invoice total matches PO", category: "value", severity: "warning",
    why: "Value differences between PO and invoice signal pricing errors, unapproved surcharges or partial shipments." },
  { id: "commercial.total_quantity", name: "Total quantity consistent", category: "quantity", severity: "blocker",
    why: "Total units shipped must be identical on the invoice and packing list." },
  // Logistics
  { id: "logistics.port_loading", name: "Port of loading consistent", category: "logistics", severity: "warning",
    why: "Port mismatches invalidate export declarations and certificates of origin." },
  { id: "logistics.port_discharge", name: "Port of discharge consistent", category: "logistics", severity: "warning",
    why: "The import filing must reference the actual discharge port." },
  { id: "logistics.vessel", name: "Vessel / voyage consistent", category: "logistics", severity: "advisory",
    why: "Late vessel rollovers often leave stale vessel names on the invoice or packing list." },
  { id: "logistics.containers", name: "Container numbers consistent", category: "logistics", severity: "blocker",
    why: "Advance cargo filings (ISF, ENS, AMS) are keyed by container number; a typo can mean a no-load." },
  { id: "logistics.packages", name: "Package count consistent", category: "logistics", severity: "blocker",
    why: "The package count is what customs physically counts at examination and what the carrier signs for." },
  { id: "logistics.gross_weight", name: "Gross weight consistent", category: "logistics", severity: "warning",
    why: "SOLAS VGM and carrier manifests reject weights that disagree with the shipper's documents." },
  { id: "logistics.net_weight", name: "Net weight consistent", category: "logistics", severity: "advisory",
    why: "Net weight drives duty for weight-based tariffs and statistical declarations." },
  { id: "compliance.origin", name: "Country of origin consistent", category: "compliance", severity: "blocker",
    why: "Origin determines duty rates, preferential treatment and sanctions screening. Inconsistent origin is a red flag for customs." },
  // Lines
  { id: "line.missing", name: "Every item appears on every document", category: "quantity", severity: "blocker",
    why: "Goods on the packing list but not the invoice (or vice versa) are undeclared or phantom goods in the eyes of customs." },
  { id: "line.quantity", name: "Line quantities match", category: "quantity", severity: "blocker",
    why: "Quantity discrepancies between invoice and packing list are treated as misdeclaration." },
  { id: "line.description", name: "Descriptions consistent", category: "description", severity: "warning",
    why: "Customs compares goods descriptions across documents; vague or differing descriptions invite classification queries." },
  { id: "line.hs_code", name: "HS codes consistent", category: "compliance", severity: "blocker",
    why: "Different tariff classifications for the same goods change the duty payable and can lead to penalties." },
  { id: "line.unit_price", name: "Unit prices match PO", category: "value", severity: "warning",
    why: "Invoice prices that differ from the agreed PO price are disputed by the buyer and may be challenged as undervaluation." },
  { id: "line.weight", name: "Line weights consistent", category: "logistics", severity: "advisory",
    why: "Per-line weights feed statistical declarations and weight-based duty." },
  // Arithmetic
  { id: "math.line_extension", name: "Qty × price = line amount", category: "arithmetic", severity: "warning",
    why: "Extension errors are the classic invoice mistake and are caught instantly by customs valuation checks." },
  { id: "math.total_value", name: "Lines add up to the invoice total", category: "arithmetic", severity: "blocker",
    why: "The declared total must equal the sum of lines; otherwise the customs value is ambiguous." },
  { id: "math.totals", name: "Lines add up to document totals", category: "arithmetic", severity: "warning",
    why: "Totals for packages and weights must equal the sum of their lines." },
  { id: "math.net_gross", name: "Net weight ≤ gross weight", category: "arithmetic", severity: "warning",
    why: "A net weight above the gross weight is physically impossible and flags the whole document as unreliable." },
  // Validity
  { id: "valid.container_check_digit", name: "Container check digit (ISO 6346)", category: "logistics", severity: "warning",
    why: "Container numbers carry a check digit. A failed check means the number was mistyped." },
  { id: "valid.hs_format", name: "HS code format", category: "compliance", severity: "warning",
    why: "HS codes have an even number of digits, at least six." },
  { id: "valid.hs_missing", name: "HS codes present on invoice", category: "compliance", severity: "advisory",
    why: "Most destinations require the HS code on the commercial invoice." },
  { id: "valid.incoterm", name: "Incoterm is valid (2020)", category: "compliance", severity: "advisory",
    why: "Retired terms such as DDU or DAT are not recognised under Incoterms 2020 and cause L/C discrepancies." },
  { id: "valid.required_fields", name: "Required fields present", category: "compliance", severity: "warning",
    why: "Each document type has fields customs and banks will not accept without." },
  { id: "valid.date_order", name: "Document dates in order", category: "reference", severity: "advisory",
    why: "An invoice dated before its purchase order is a common sign of a re-used template." },
];

export const RULE_MAP: Record<string, RuleDef> = Object.fromEntries(RULES.map((r) => [r.id, r]));

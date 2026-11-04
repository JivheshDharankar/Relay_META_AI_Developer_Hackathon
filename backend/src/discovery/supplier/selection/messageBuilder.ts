import { PurchaseOrder } from './types';

export class PurchaseOrderMessageBuilder {
  /**
   * Builds a standardized, professional, privacy-safe Purchase Order document text
   * suitable for supplier dispatch, completely free of any resident identities or internal data.
   */
  public buildPurchaseOrderText(po: PurchaseOrder): string {
    const lines: string[] = [];
    lines.push('================================================================');
    lines.push('                   OFFICIAL PURCHASE ORDER                      ');
    lines.push('================================================================');
    lines.push(`PO Number:         ${po.poNumber}`);
    lines.push(`Date:              ${po.createdAt.toISOString().split('T')[0]}`);
    lines.push(`RFQ Reference:     ${po.rfqId}`);
    lines.push(`Supplier:          ${po.supplierName}`);
    lines.push(`Contact:           ${po.supplierContact}`);
    lines.push(`Delivery Area:     ${po.deliveryArea}`);
    lines.push(`Delivery Deadline: ${po.deliveryDeadline.toISOString()}`);
    lines.push('----------------------------------------------------------------');
    lines.push('LINE ITEMS:');
    for (const item of po.lines) {
      lines.push(
        `#${item.lineNumber} ${item.productName.padEnd(25)} | ${item.quantity.toString().padStart(6)} ${item.unit.padEnd(4)} @ ₹${item.unitPrice.toFixed(2)} = ₹${item.lineTotal.toFixed(2)}`
      );
    }
    lines.push('----------------------------------------------------------------');
    lines.push(`Subtotal:          ₹${po.subtotal.toFixed(2)}`);
    lines.push(`Delivery Fee:      ₹${po.deliveryFee.toFixed(2)}`);
    lines.push(`Tax / GST:         ₹${po.tax.toFixed(2)}`);
    lines.push(`Total Amount:      ₹${po.total.toFixed(2)} (${po.currency})`);
    lines.push('----------------------------------------------------------------');
    const supplierTerms = (po.terms || '')
      .replace(/resident mandate/gi, 'pre-authorized settlement')
      .replace(/resident/gi, 'community')
      .replace(/mandate/gi, 'escrow');
    lines.push(`Commercial Terms:  ${supplierTerms}`);
    lines.push('================================================================');
    lines.push('Issued by: Relay Autonomous Community Procurement');

    return lines.join('\n');
  }
}

export const purchaseOrderMessageBuilder = new PurchaseOrderMessageBuilder();


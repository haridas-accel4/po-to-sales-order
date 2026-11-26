/**
 * Pure, reusable validation rules for extracted / reviewed purchase orders.
 * Each function returns a list of issues:
 *   { severity: 'ERROR'|'WARNING', code, field, lineNumber, message }
 * ERROR issues block Sales Order creation (-> NEEDS_REVIEW).
 */

export const issue = (severity, code, message, { field = null, lineNumber = null } = {}) =>
    ({ severity, code, field, lineNumber, message });

const decimals = (n) => (String(n).split('.')[1] ?? '').length;

/** Header and item fields required for Sales Order creation. */
export function validateRequiredFields(header, items) {
    const issues = [];
    if (!header?.customerPoNumber) issues.push(issue('ERROR', 'REQUIRED_FIELD', 'Customer PO number is missing.', { field: 'customerPoNumber' }));
    if (!header?.poDate) issues.push(issue('ERROR', 'REQUIRED_FIELD', 'PO date is missing.', { field: 'poDate' }));
    if (!header?.requestedDeliveryDate) {
        issues.push(issue('WARNING', 'NO_DELIVERY_DATE', 'No requested delivery date; SAP default scheduling will apply.', { field: 'requestedDeliveryDate' }));
    } else if (header.poDate && header.requestedDeliveryDate < header.poDate) {
        issues.push(issue('ERROR', 'INVALID_DELIVERY_DATE',
            `Requested delivery date ${header.requestedDeliveryDate} is before the PO date ${header.poDate}.`, { field: 'requestedDeliveryDate' }));
    }

    if (!items?.length) {
        issues.push(issue('ERROR', 'NO_ITEMS', 'The order has no line items.'));
        return issues;
    }
    const seen = new Set();
    for (const it of items) {
        const lineNumber = it.lineNumber ?? null;
        if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
            issues.push(issue('ERROR', 'REQUIRED_FIELD', 'Line number must be a positive whole number.', { field: 'lineNumber', lineNumber }));
        } else if (seen.has(lineNumber)) {
            issues.push(issue('ERROR', 'DUPLICATE_LINE', `Line number ${lineNumber} is used more than once.`, { field: 'lineNumber', lineNumber }));
        } else seen.add(lineNumber);
        if (!it.customerMaterial) issues.push(issue('ERROR', 'REQUIRED_FIELD', 'Customer material is missing.', { field: 'customerMaterial', lineNumber }));
        if (!it.customerUom) issues.push(issue('ERROR', 'REQUIRED_FIELD', 'Unit of measure is missing.', { field: 'customerUom', lineNumber }));
        if (it.requestedDeliveryDate && header?.poDate && it.requestedDeliveryDate < header.poDate) {
            issues.push(issue('ERROR', 'INVALID_DELIVERY_DATE',
                `Requested delivery date ${it.requestedDeliveryDate} is before the PO date ${header.poDate}.`, { field: 'requestedDeliveryDate', lineNumber }));
        }
        if (it.priceUnit !== null && it.priceUnit !== undefined && !(Number.isInteger(Number(it.priceUnit)) && Number(it.priceUnit) > 0)) {
            issues.push(issue('ERROR', 'INVALID_PRICE_UNIT', `Price unit must be a positive whole number (got ${it.priceUnit}).`, { field: 'priceUnit', lineNumber }));
        }
    }
    return issues;
}

/** Quantities must be numeric, > 0 and have at most 3 decimals. */
export function validateQuantities(items) {
    const issues = [];
    for (const it of items ?? []) {
        const q = it.quantity === null || it.quantity === undefined || it.quantity === '' ? NaN : Number(it.quantity);
        const opts = { field: 'quantity', lineNumber: it.lineNumber ?? null };
        if (!Number.isFinite(q)) issues.push(issue('ERROR', 'INVALID_QUANTITY', 'Quantity is missing or not numeric.', opts));
        else if (q <= 0) issues.push(issue('ERROR', 'INVALID_QUANTITY', `Quantity must be greater than zero (got ${q}).`, opts));
        else if (decimals(q) > 3) issues.push(issue('ERROR', 'INVALID_QUANTITY', `Quantity ${q} has more than 3 decimals.`, opts));
    }
    return issues;
}

/** Extraction confidence (0..1) must reach the configured minimum. */
export function validateConfidence(confidence, minConfidence) {
    const c = confidence === null || confidence === undefined ? NaN : Number(confidence);
    if (!Number.isFinite(c)) {
        return [issue('ERROR', 'LOW_CONFIDENCE', 'Extraction confidence is unknown; manual review required.', { field: 'extractionConfidence' })];
    }
    if (c < minConfidence) {
        return [issue('ERROR', 'LOW_CONFIDENCE',
            `Extraction confidence ${c} is below the required ${minConfidence}; manual review required.`, { field: 'extractionConfidence' })];
    }
    return [];
}

/** Final status from the collected issues. */
export function determineStatus(issues) {
    return issues.some((i) => i.severity === 'ERROR') ? 'NEEDS_REVIEW' : 'VALIDATED';
}

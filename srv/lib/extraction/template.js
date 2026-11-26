import { ExtractionError } from '../errors.js';

/**
 * Fixed PO template (CSV / XLSX), one purchase order per file:
 *   CustomerPO, PODate, DeliveryDate, Line, CustomerMaterial, Description, Quantity, UoM, UnitPrice
 * Header columns are matched case-insensitively; extra columns are ignored.
 * PO header values are repeated on each row and must be identical.
 */
export const TEMPLATE_COLUMNS = [
    'CustomerPO', 'PODate', 'DeliveryDate', 'Line', 'CustomerMaterial',
    'Description', 'Quantity', 'UoM', 'UnitPrice',
];

const MAX_ITEMS = 1000;

/**
 * @typedef {object} PurchaseOrderData  Common PO structure produced by every extractor.
 * @property {{customerPoNumber:string, poDate:string, requestedDeliveryDate:string|null}} header  ISO dates
 * @property {Array<{lineNumber:number, customerMaterial:string, description:string|null,
 *                   quantity:number, uom:string, unitPrice:number|null}>} items
 * @property {{method:string, confidence:number}} extraction
 */

const normalizeHeader = (h) => String(h ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();

/**
 * Resolve template columns to indices in the given header row.
 * @param {Array<unknown>} headerRow
 * @returns {Record<string, number>}
 */
export function mapColumns(headerRow) {
    const normalized = headerRow.map(normalizeHeader);
    const errors = [];
    const index = {};
    for (const col of TEMPLATE_COLUMNS) {
        const hits = normalized.reduce((acc, h, i) => (h === col.toLowerCase() ? [...acc, i] : acc), []);
        if (hits.length === 0) errors.push({ field: col, message: `Required column '${col}' is missing.` });
        else if (hits.length > 1) errors.push({ field: col, message: `Column '${col}' appears more than once.` });
        else index[col] = hits[0];
    }
    if (errors.length) {
        throw new ExtractionError(
            `Invalid template header: ${errors.map((e) => e.message).join(' ')} Expected columns: ${TEMPLATE_COLUMNS.join(', ')}.`,
            errors,
            'INVALID_TEMPLATE'
        );
    }
    return index;
}

// ---------------------------------------------------------------- value parsers

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toText(v) {
    if (isBlank(v)) return null;
    if (v instanceof Date) return null; // dates are not valid text values here
    return String(v).trim();
}

function isoDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
}

/**
 * Parse a date: JS Date (XLSX date cell), 'YYYY-MM-DD' or 'DD.MM.YYYY'.
 * Slash formats are rejected because DD/MM vs MM/DD is ambiguous.
 * @returns {string|null|undefined} ISO date, null if blank, undefined if invalid
 */
export function parseDate(v) {
    if (isBlank(v)) return null;
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return undefined;
        return isoDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) ?? undefined;
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return isoDate(+m[1], +m[2], +m[3]) ?? undefined;
    m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (m) return isoDate(+m[3], +m[2], +m[1]) ?? undefined;
    return undefined;
}

/**
 * Parse a non-negative decimal. Accepts JS numbers or strings using '.' as the
 * decimal separator. Thousands separators / commas are rejected as ambiguous.
 * @returns {number|null|undefined} number, null if blank, undefined if invalid
 */
export function parseDecimal(v, maxDecimals) {
    if (isBlank(v)) return null;
    let s;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return undefined;
        s = String(v);
        if (/e/i.test(s)) return undefined;
    } else if (typeof v === 'string') {
        s = v.trim();
    } else {
        return undefined;
    }
    const m = /^-?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return undefined;
    if ((m[2]?.length ?? 0) > maxDecimals) return undefined;
    if (m[1].length > 10) return undefined;
    return Number(s);
}

// ---------------------------------------------------------------- row conversion

/**
 * Convert raw template rows into the common PO structure.
 * Collects all errors and throws one ExtractionError listing them.
 *
 * @param {Array<{rowNumber:number, values:Array<unknown>}>} rows data rows (header excluded)
 * @param {Record<string, number>} columns result of mapColumns()
 * @param {string} method extraction method label
 * @returns {PurchaseOrderData}
 */
export function rowsToPurchaseOrder(rows, columns, method) {
    const errors = [];
    const err = (rowNumber, field, message) => errors.push({ rowNumber, field, message: `Row ${rowNumber}: ${message}` });

    const dataRows = rows.filter((r) => r.values.some((v) => !isBlank(v)));
    if (dataRows.length === 0) {
        throw new ExtractionError('The file contains no line items.', [{ message: 'No data rows below the header.' }], 'NO_ITEMS');
    }
    if (dataRows.length > MAX_ITEMS) {
        throw new ExtractionError(`The file contains ${dataRows.length} line items; the maximum is ${MAX_ITEMS}.`, [], 'TOO_MANY_ITEMS');
    }

    const get = (row, col) => row.values[columns[col]];
    let header = null;
    const items = [];
    const seenLines = new Set();

    for (const row of dataRows) {
        const n = row.rowNumber;

        // --- header fields (must be the same on every row)
        const po = toText(get(row, 'CustomerPO'));
        const poDate = parseDate(get(row, 'PODate'));
        const delivery = parseDate(get(row, 'DeliveryDate'));

        if (!po) err(n, 'CustomerPO', 'CustomerPO is required.');
        else if (po.length > 35) err(n, 'CustomerPO', 'CustomerPO must be at most 35 characters.');
        if (poDate === null) err(n, 'PODate', 'PODate is required.');
        else if (poDate === undefined) err(n, 'PODate', `PODate '${get(row, 'PODate')}' is not a valid date (use YYYY-MM-DD or DD.MM.YYYY).`);
        if (delivery === undefined) err(n, 'DeliveryDate', `DeliveryDate '${get(row, 'DeliveryDate')}' is not a valid date (use YYYY-MM-DD or DD.MM.YYYY).`);

        const rowHeader = { customerPoNumber: po, poDate: poDate ?? null, requestedDeliveryDate: delivery ?? null };
        if (!header) header = rowHeader;
        else {
            for (const [key, col] of [['customerPoNumber', 'CustomerPO'], ['poDate', 'PODate'], ['requestedDeliveryDate', 'DeliveryDate']]) {
                if (rowHeader[key] !== header[key] && rowHeader[key] !== null && header[key] !== null) {
                    err(n, col, `${col} '${rowHeader[key]}' differs from the first row ('${header[key]}'); a file must contain exactly one PO.`);
                }
                if (header[key] === null) header[key] = rowHeader[key];
            }
        }

        // --- item fields
        const lineRaw = get(row, 'Line');
        const line = parseDecimal(lineRaw, 0);
        if (line === null) err(n, 'Line', 'Line is required.');
        else if (line === undefined || line <= 0 || !Number.isInteger(line)) err(n, 'Line', `Line '${lineRaw}' must be a positive whole number.`);
        else if (seenLines.has(line)) err(n, 'Line', `Line ${line} appears more than once.`);
        else seenLines.add(line);

        const material = toText(get(row, 'CustomerMaterial'));
        if (!material) err(n, 'CustomerMaterial', 'CustomerMaterial is required.');
        else if (material.length > 35) err(n, 'CustomerMaterial', 'CustomerMaterial must be at most 35 characters.');

        const description = toText(get(row, 'Description'));
        if (description && description.length > 100) err(n, 'Description', 'Description must be at most 100 characters.');

        const qtyRaw = get(row, 'Quantity');
        const quantity = parseDecimal(qtyRaw, 3);
        if (quantity === null) err(n, 'Quantity', 'Quantity is required.');
        else if (quantity === undefined) err(n, 'Quantity', `Quantity '${qtyRaw}' is not a valid number (use '.' as decimal separator, max. 3 decimals, no thousands separators).`);
        else if (quantity <= 0) err(n, 'Quantity', `Quantity must be greater than zero (got ${quantity}).`);

        const uom = toText(get(row, 'UoM'));
        if (!uom) err(n, 'UoM', 'UoM is required.');
        else if (uom.length > 10) err(n, 'UoM', 'UoM must be at most 10 characters.');

        const priceRaw = get(row, 'UnitPrice');
        const unitPrice = parseDecimal(priceRaw, 2);
        if (unitPrice === undefined) err(n, 'UnitPrice', `UnitPrice '${priceRaw}' is not a valid amount (use '.' as decimal separator, max. 2 decimals).`);
        else if (unitPrice !== null && unitPrice < 0) err(n, 'UnitPrice', 'UnitPrice must not be negative.');

        items.push({ lineNumber: line, customerMaterial: material, description, quantity, uom, unitPrice: unitPrice ?? null });
    }

    if (errors.length) {
        const shown = errors.slice(0, 10).map((e) => e.message).join(' ');
        const more = errors.length > 10 ? ` (+${errors.length - 10} more)` : '';
        throw new ExtractionError(`The file has ${errors.length} error(s): ${shown}${more}`, errors, 'INVALID_DATA');
    }

    items.sort((a, b) => a.lineNumber - b.lineNumber);
    return { header, items, extraction: { method, confidence: 1 } };
}

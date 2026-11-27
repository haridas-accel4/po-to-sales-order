import { ExtractionError } from '../errors.js';
import { cleanText } from '../text.js';

/**
 * Fixed PO template (CSV / XLSX), one purchase order per file:
 *   CustomerPO, PODate, DeliveryDate, Line, CustomerMaterial, Description, Quantity, UoM, UnitPrice
 * Header columns are matched case-insensitively; extra columns are ignored.
 * PO header values are repeated on each row and must be identical.
 * UoM may be empty: SAP then uses the unit from the material master.
 *
 * Item-level columns that only the PDF reader supplies (not part of the CSV/XLSX template):
 *   ItemDeliveryDate  delivery date of the item (header date = earliest item date if none is given)
 *   PriceUnit         quantity the unit price refers to ("13.00 USD per 1 PC")
 *   Currency          currency of the item prices; all items must use the same one
 */
export const TEMPLATE_COLUMNS = [
    'CustomerPO', 'PODate', 'DeliveryDate', 'Line', 'CustomerMaterial',
    'Description', 'Quantity', 'UoM', 'UnitPrice',
];

const MAX_ITEMS = 1000;

/**
 * @typedef {object} PurchaseOrderData  Common PO structure produced by every extractor.
 * @property {{customerPoNumber:string, poDate:string, requestedDeliveryDate:string|null,
 *             currency?:string|null}} header  ISO dates
 * @property {Array<{lineNumber:number, customerMaterial:string, description:string|null,
 *                   quantity:number, uom:string, unitPrice:number|null,
 *                   priceUnit?:number, requestedDeliveryDate?:string|null}>} items
 *   priceUnit defaults to 1; an item delivery date of null falls back to the header date
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

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && cleanText(v) === '');

function toText(v) {
    if (isBlank(v)) return null;
    if (v instanceof Date) return null; // dates are not valid text values here
    return cleanText(v);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

/** English month name or abbreviation ('Mar', 'March', 'Sept') -> 1..12, else null. */
function monthNumber(name) {
    const n = name.toLowerCase();
    if (n.length < 3) return null;
    const i = MONTHS.findIndex((m) => m.startsWith(n));
    return i < 0 ? null : i + 1;
}

function isoDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
}

export const DATE_FORMATS = 'YYYY-MM-DD, DD.MM.YYYY or with the month name, e.g. Mar 6, 2026 / 6 Mar 2026';

/**
 * Parse a date: JS Date (XLSX date cell), 'YYYY-MM-DD', 'DD.MM.YYYY' (also 'D.M.YYYY'), or with
 * an English month name as SAP prints it: 'Mar 6, 2026', 'March 6 2026', '6 Mar 2026', '06-Mar-2026'.
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
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (m) return isoDate(+m[3], +m[2], +m[1]) ?? undefined;
    m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (m) return monthNumber(m[1]) ? isoDate(+m[3], monthNumber(m[1]), +m[2]) ?? undefined : undefined;
    m = /^(\d{1,2})\.?(?:\s+|-)([A-Za-z]+)\.?(?:\s+|-)(\d{4})$/.exec(s);
    if (m) return monthNumber(m[2]) ? isoDate(+m[3], monthNumber(m[2]), +m[1]) ?? undefined : undefined;
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
    const has = (col) => columns[col] !== undefined;
    let header = null;
    const items = [];
    const seenLines = new Set();
    const currencies = new Set();

    for (const row of dataRows) {
        const n = row.rowNumber;

        // --- header fields (must be the same on every row)
        const po = toText(get(row, 'CustomerPO'));
        const poDate = parseDate(get(row, 'PODate'));
        const delivery = parseDate(get(row, 'DeliveryDate'));

        if (!po) err(n, 'CustomerPO', 'CustomerPO is required.');
        else if (po.length > 35) err(n, 'CustomerPO', 'CustomerPO must be at most 35 characters.');
        if (poDate === null) err(n, 'PODate', 'PODate is required.');
        else if (poDate === undefined) err(n, 'PODate', `PODate '${get(row, 'PODate')}' is not a valid date (use ${DATE_FORMATS}).`);
        if (delivery === undefined) err(n, 'DeliveryDate', `DeliveryDate '${get(row, 'DeliveryDate')}' is not a valid date (use ${DATE_FORMATS}).`);

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

        // optional: without a UoM SAP takes the unit from the material master
        const uom = toText(get(row, 'UoM'));
        if (uom && uom.length > 10) err(n, 'UoM', 'UoM must be at most 10 characters.');

        const priceRaw = get(row, 'UnitPrice');
        const unitPrice = parseDecimal(priceRaw, 2);
        if (unitPrice === undefined) err(n, 'UnitPrice', `UnitPrice '${priceRaw}' is not a valid amount (use '.' as decimal separator, max. 2 decimals).`);
        else if (unitPrice !== null && unitPrice < 0) err(n, 'UnitPrice', 'UnitPrice must not be negative.');

        const item = { lineNumber: line, customerMaterial: material, description, quantity, uom, unitPrice: unitPrice ?? null };

        if (has('ItemDeliveryDate')) {
            const date = parseDate(get(row, 'ItemDeliveryDate'));
            if (date === undefined) err(n, 'DeliveryDate', `Delivery date '${get(row, 'ItemDeliveryDate')}' is not a valid date (use ${DATE_FORMATS}).`);
            item.requestedDeliveryDate = date ?? null;
        }
        if (has('PriceUnit')) {
            const raw = get(row, 'PriceUnit');
            const priceUnit = parseDecimal(raw, 0);
            if (priceUnit === undefined || priceUnit === 0) err(n, 'PriceUnit', `Price unit '${raw}' must be a positive whole number.`);
            item.priceUnit = priceUnit || 1;
        }
        if (has('Currency')) {
            const currency = toText(get(row, 'Currency'));
            if (currency && !/^[A-Z]{3}$/.test(currency)) err(n, 'Currency', `Currency '${currency}' is not a 3-letter ISO code.`);
            else if (currency) currencies.add(currency);
        }
        items.push(item);
    }

    if (currencies.size > 1) {
        errors.push({ rowNumber: null, field: 'Currency',
            message: `The items use different currencies (${[...currencies].join(', ')}); a PO must be in one currency.` });
    }
    if (has('Currency')) header.currency = currencies.size === 1 ? [...currencies][0] : null;
    // no order-level delivery date: the earliest item date
    if (!header.requestedDeliveryDate) {
        const dates = items.map((i) => i.requestedDeliveryDate).filter(Boolean).sort();
        if (dates.length) header.requestedDeliveryDate = dates[0];
    }

    if (errors.length) {
        const shown = errors.slice(0, 10).map((e) => e.message).join(' ');
        const more = errors.length > 10 ? ` (+${errors.length - 10} more)` : '';
        throw new ExtractionError(`The file has ${errors.length} error(s): ${shown}${more}`, errors, 'INVALID_DATA');
    }

    items.sort((a, b) => a.lineNumber - b.lineNumber);
    return { header, items, extraction: { method, confidence: 1 } };
}

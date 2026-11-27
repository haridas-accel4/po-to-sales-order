import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ExtractionError } from '../errors.js';
import { cleanText } from '../text.js';
import { TEMPLATE_COLUMNS, rowsToPurchaseOrder } from './template.js';

export const METHOD = 'PDF_TEMPLATE_V1';

/**
 * Deterministic extraction of a template PDF: a text PDF (not a scan), one purchase order per file.
 *
 *   PURCHASE ORDER
 *   Customer PO:    PO-2027-0001          <- labelled header fields, anywhere outside the table
 *   PO Date:        2027-01-15               ("label: value", same line)
 *   Delivery Date:  2027-02-01               (optional)
 *
 *   Line  Customer Material  Description   Quantity  UoM  Unit Price    <- table header row
 *   10    ACME-BOLT-10       Hex bolt M10  100       PCS  0.25
 *   20    ACME-NUT-10        Hex nut M10   100       PCS  0.10
 *                            (wrapped description lines are joined)
 *
 * - Table columns are matched by name (or a common synonym, see COLUMN_NAMES), ignoring case, spaces
 *   and punctuation; their order is free and extra columns (e.g. "Total") are ignored. Line,
 *   CustomerMaterial and Quantity are required. CustomerPO / PODate may also be table columns.
 * - A Delivery Date column is the item's delivery date; without a 'Delivery Date:' label the
 *   order's requested delivery date is the earliest item date.
 * - A table spanning several pages repeats its header row on each page (or continues with the
 *   column positions of the last header).
 * - Values follow the CSV/XLSX template rules (template.js), dates also as 'Mar 6, 2026'.
 *
 * It also reads the standard SAP purchase order form (MM purchase order output), where:
 *   - the PO number is labelled 'Purchase Order:' and the PO date 'Created on:'
 *   - the table is  Item | ID | Description | Quantity | Delivery Date | Net Price | Net Value
 *   - the quantity carries the unit ('1 PC'), the price the currency ('13.00 USD') and, on the
 *     line below, the price unit ('per 1 PC')
 *   - schedule lines and Incoterms are printed under the item and are ignored
 *   - amounts may use thousands separators: the decimal separator is taken from the prices
 *     ('1,000 PC' / '13.00 USD' or '1.000 ST' / '13,00 EUR')
 *
 * The page text is read with its positions (pdf.js); rows are rebuilt from the y position and
 * values are assigned to columns from their x position under the table header.
 */

const MAX_PAGES = 50;
const TABLE_COLUMNS = ['Line', 'CustomerMaterial', 'Description', 'Quantity', 'UoM', 'UnitPrice', 'DeliveryDate'];
const REQUIRED_TABLE_COLUMNS = ['Line', 'CustomerMaterial', 'Quantity'];
const HEADER_FIELDS = ['CustomerPO', 'PODate', 'DeliveryDate'];
const FIELD_LABELS = { CustomerPO: 'Customer PO', PODate: 'PO Date', DeliveryDate: 'Delivery Date' };

/** Table header names per column (compared without case, spaces and punctuation). */
const COLUMN_NAMES = {
    CustomerPO: ['CustomerPO'],
    PODate: ['PODate'],
    Line: ['Line', 'Line No', 'Item', 'Item No', 'Pos', 'Position'],
    CustomerMaterial: ['Customer Material', 'ID', 'Material', 'Material No', 'Material Number', 'Item ID', 'Part No', 'Part Number'],
    Description: ['Description', 'Material Description', 'Short Text'],
    Quantity: ['Quantity', 'Qty', 'Order Quantity'],
    UoM: ['UoM', 'Unit', 'Unit of Measure'],
    UnitPrice: ['Unit Price', 'Net Price', 'Price'],
    DeliveryDate: ['Delivery Date', 'Delivery Date / Service Period', 'Requested Delivery Date'],
};

/** Header field labels, followed by ':' (the value follows on the same line). */
const LABEL = /\b(customer\s*po(?:\s*(?:no\.?|number|#))?|po\s*(?:no\.?|number|#)|purchase\s*order(?:\s*(?:no\.?|number|#))?|(?:po|order|purchase\s*order|document)\s*date|created\s*on|(?:requested\s*)?delivery\s*date)\s*:/gi;

const key = (s) => cleanText(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMN_BY_KEY = new Map(Object.entries(COLUMN_NAMES).flatMap(([c, names]) => names.map((n) => [key(n), c])));

function labelField(label) {
    const k = key(label);
    if (k.includes('delivery')) return 'DeliveryDate';
    return k.includes('date') || k.includes('created') ? 'PODate' : 'CustomerPO';
}

/** Price-unit text printed below an SAP price: 'per 1 PC', 'per 100'. */
const PER = /^per\s+([\d.,]+)(?:\s+[A-Za-z][A-Za-z0-9]*)?$/i;

// ---------------------------------------------------------------- reading the PDF

/**
 * Convert a pdf.js text item into positioned text pieces. A piece of text that contains
 * a run of 2+ spaces (one text run spanning several table cells) is split, with the
 * positions estimated from the character offsets.
 */
function toPieces(item) {
    const text = cleanText(item.str);
    if (!text) return [];
    const [a, b, c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 10;
    const width = item.width || 0;
    if (!/\s{2,}/.test(item.str)) return [{ x, y, w: width, size, text }];
    const charWidth = width / item.str.length;
    return [...item.str.matchAll(/\S+(?: \S+)*/g)].map((m) => ({
        x: x + m.index * charWidth, y, w: m[0].length * charWidth, size, text: cleanText(m[0]),
    })).filter((p) => p.text);
}

/**
 * Read the positioned text of every page.
 * @param {Buffer} buffer
 * @returns {Promise<Array<Array<{x:number, y:number, w:number, size:number, text:string}>>>}
 */
export async function readPdfText(buffer) {
    const task = getDocument({
        data: new Uint8Array(buffer), // copy: pdf.js takes ownership of the array
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
    });
    let doc;
    try {
        doc = await task.promise;
    } catch (e) {
        await task.destroy();
        if (e?.name === 'PasswordException') {
            throw new ExtractionError('The PDF is password-protected. Send the purchase order without a password.', [], 'ENCRYPTED_PDF');
        }
        throw new ExtractionError(`The PDF file could not be opened: ${e?.message ?? e}`, [], 'INVALID_PDF');
    }
    try {
        if (doc.numPages > MAX_PAGES) {
            throw new ExtractionError(`The PDF has ${doc.numPages} pages; the maximum is ${MAX_PAGES}.`, [], 'TOO_MANY_PAGES');
        }
        const pages = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const { items } = await page.getTextContent();
            pages.push(items.flatMap((it) => (typeof it.str === 'string' ? toPieces(it) : [])));
            page.cleanup();
        }
        return pages;
    } catch (e) {
        if (e instanceof ExtractionError) throw e;
        throw new ExtractionError(`The PDF file could not be read: ${e?.message ?? e}`, [], 'INVALID_PDF');
    } finally {
        await task.destroy();
    }
}

// ---------------------------------------------------------------- layout -> rows

/** Group the pieces of one page into lines (top to bottom), each sorted left to right. */
function groupLines(pieces) {
    const sorted = [...pieces].sort((p, q) => q.y - p.y || p.x - q.x);
    const lines = [];
    for (const p of sorted) {
        const line = lines.at(-1);
        if (line && Math.abs(line.y - p.y) <= Math.max(2, 0.4 * Math.min(line.size, p.size))) line.pieces.push(p);
        else lines.push({ y: p.y, size: p.size, pieces: [p] });
    }
    for (const line of lines) line.pieces.sort((p, q) => p.x - q.x);
    return lines;
}

/** The text of all pages, line by line (cells separated by tabs) - used to identify the customer. */
export function pagesToText(pages) {
    return pages.map((pieces) => groupLines(pieces).map((line) => cells(line).map((c) => c.text).join('\t')).join('\n')).join('\n');
}

/** Merge pieces separated by less than ~half a character height into cells (words of one heading). */
function cells(line) {
    const out = [];
    for (const p of line.pieces) {
        const prev = out.at(-1);
        const gap = prev ? p.x - (prev.x + prev.w) : Infinity;
        if (gap < 0.6 * Math.max(prev?.size ?? 0, p.size)) {
            prev.text += gap > 0.1 * p.size ? ` ${p.text}` : p.text;
            prev.w = Math.max(prev.w, p.x + p.w - prev.x);
        } else {
            out.push({ ...p });
        }
    }
    return out;
}

/**
 * Is this line the item table header? Returns the column bands (x ranges) if so, otherwise
 * the template columns it contains (to explain an incomplete header).
 */
function tableHeader(line) {
    const cs = cells(line);
    const columns = cs.map((c) => COLUMN_BY_KEY.get(key(c.text)) ?? null);
    const found = columns.filter(Boolean);
    const duplicates = [...new Set(found.filter((c, i) => found.indexOf(c) !== i))];
    const missing = REQUIRED_TABLE_COLUMNS.filter((c) => !found.includes(c));
    if (missing.length || duplicates.length) return { bands: null, found, missing, duplicates };

    // each column owns the x range from halfway to its left neighbour to halfway to its right neighbour
    const bands = cs.map((c, i) => ({
        column: columns[i],
        start: c.x,
        end: c.x + c.w,
        left: i === 0 ? -Infinity : (cs[i - 1].x + cs[i - 1].w + c.x) / 2,
        right: i === cs.length - 1 ? Infinity : (c.x + c.w + cs[i + 1].x) / 2,
    }));
    return { bands, found, missing, duplicates };
}

/** How close (pt) a value's edge must be to its heading's edge to count as aligned with it. */
const ALIGN_TOLERANCE = 2;

/**
 * The band a piece belongs to: the column whose heading it is left- or right-aligned with (text
 * and numbers in tables are aligned with their heading, even when a long value runs past the
 * middle between two headings), otherwise the largest horizontal overlap (a zero-width piece: its start).
 */
function bandOf(piece, bands) {
    if (piece.w > 0) {
        const aligned = bands.find((b) => Math.abs(piece.x - b.start) <= ALIGN_TOLERANCE)
            ?? bands.find((b) => Math.abs(piece.x + piece.w - b.end) <= ALIGN_TOLERANCE);
        if (aligned) return aligned;
    }
    let best = null;
    let bestOverlap = -Infinity;
    for (const b of bands) {
        const overlap = piece.w > 0
            ? Math.min(piece.x + piece.w, b.right) - Math.max(piece.x, b.left)
            : (piece.x >= b.left && piece.x < b.right ? 0 : -Infinity);
        if (overlap > bestOverlap) {
            best = b;
            bestOverlap = overlap;
        }
    }
    return best;
}

const AMOUNT = String.raw`(?:[A-Z]{3} )?[\d.,]+(?: [A-Z]{3})?`;
const TWO_AMOUNTS = new RegExp(`^(${AMOUNT}) (${AMOUNT})$`);

/**
 * pdf.js joins text runs less than ~0.6 em apart into one piece with a single space, e.g. a wide
 * net price and net value: '1,234.50 USD 12,345.00 USD'. Such a piece is split back into its two
 * amounts when it crosses two columns (positions estimated from the character offsets).
 */
function splitJoinedAmounts(piece, bands) {
    const m = TWO_AMOUNTS.exec(piece.text);
    if (!m || bandOf(piece, bands) === bandOf({ ...piece, x: piece.x + piece.w, w: 0 }, bands)) return [piece];
    const charWidth = piece.w / piece.text.length;
    const right = m[1].length + 1;
    return [
        { ...piece, text: m[1], w: m[1].length * charWidth },
        { ...piece, text: m[2], x: piece.x + right * charWidth, w: m[2].length * charWidth },
    ];
}

/** Split a line into column values ({Line: '10', ...}); pieces under extra columns are dropped. */
function columnValues(line, bands) {
    const values = {};
    for (const p of line.pieces.flatMap((piece) => splitJoinedAmounts(piece, bands))) {
        const column = bandOf(p, bands)?.column;
        if (column) values[column] = values[column] ? `${values[column]} ${p.text}` : p.text;
    }
    return values;
}

const isItemRow = (values) =>
    /^\d{1,6}$/.test(values.Line ?? '') && Object.keys(values).some((c) => c !== 'Line' && TABLE_COLUMNS.includes(c));

/** Labelled header fields in a line: [{field, value}] ("Customer PO: X   PO Date: Y"). */
function labelledFields(line) {
    const text = cells(line).map((c) => c.text).join('\t');
    const matches = [...text.matchAll(LABEL)];
    return matches.map((m, i) => {
        const end = matches[i + 1]?.index ?? text.length;
        const value = text.slice(m.index + m[0].length, end).split('\t').map(cleanText).find(Boolean) ?? null;
        return { field: labelField(m[1]), label: cleanText(m[1]), value };
    });
}

/**
 * Turn the positioned text of all pages into template rows plus the labelled header fields.
 * @param {Array<Array<{x:number, y:number, w:number, size:number, text:string}>>} pages
 */
export function layoutToRows(pages) {
    if (!pages.some((p) => p.length)) {
        throw new ExtractionError(
            'The PDF contains no readable text (it is probably a scanned image). Only PDFs created from a ' +
            'system or document (with selectable text) in the PO template can be read.', [], 'NO_TEXT');
    }

    let bands = null;
    let nearest = null; // most complete header-like line, to explain a missing table header
    const rows = [];
    const fields = {};
    const conflicts = [];

    pages.forEach((pieces, pageIndex) => {
        let previous = null; // last line of this page that was an item row or continuation
        for (const line of groupLines(pieces)) {
            const header = tableHeader(line);
            if (header.bands) {
                bands = header.bands;
                previous = null;
                continue;
            }
            if (!bands && header.found.length >= 3 && header.found.length > (nearest?.found.length ?? 0)) nearest = header;

            if (bands) {
                const values = columnValues(line, bands);
                if (isItemRow(values)) {
                    rows.push({ page: pageIndex + 1, values });
                    previous = line;
                    continue;
                }
                // right below an item row: a wrapped description and/or the price unit ('per 1 PC')
                const names = Object.keys(values);
                const continuation = names.length > 0 && names.every((c) =>
                    c === 'Description' || (c === 'UnitPrice' && PER.test(values.UnitPrice)));
                if (previous && continuation && previous.y - line.y <= 1.6 * Math.max(line.size, previous.size)) {
                    const item = rows.at(-1).values;
                    if (values.Description) item.Description = item.Description ? `${item.Description} ${values.Description}` : values.Description;
                    if (values.UnitPrice) item.PriceUnit = PER.exec(values.UnitPrice)[1];
                    previous = line;
                    continue;
                }
            }
            previous = null;

            for (const { field, label, value } of labelledFields(line)) {
                if (!value) continue;
                if (fields[field] === undefined) fields[field] = value;
                else if (fields[field] !== value) {
                    conflicts.push({ field, message: `${FIELD_LABELS[field]} appears with different values ('${fields[field]}' and '${value}' after '${label}:'); a file must contain exactly one PO.` });
                }
            }
        }
    });

    if (!bands) {
        const expected = `Expected a table header row with at least the columns: ${REQUIRED_TABLE_COLUMNS.join(', ')} ` +
            `(optional: ${TABLE_COLUMNS.filter((c) => !REQUIRED_TABLE_COLUMNS.includes(c)).join(', ')}).`;
        if (nearest) {
            const problems = [
                ...nearest.missing.map((c) => ({ field: c, message: `Required column '${c}' is missing.` })),
                ...nearest.duplicates.map((c) => ({ field: c, message: `Column '${c}' appears more than once.` })),
            ];
            throw new ExtractionError(`Invalid item table header: ${problems.map((p) => p.message).join(' ')} ${expected}`, problems, 'INVALID_TEMPLATE');
        }
        throw new ExtractionError(`No item table found in the PDF. ${expected}`, [{ message: `No item table found. ${expected}` }], 'INVALID_TEMPLATE');
    }
    if (conflicts.length) {
        throw new ExtractionError(`The PDF has ${conflicts.length} error(s): ${conflicts.map((c) => c.message).join(' ')}`, conflicts, 'INVALID_DATA');
    }
    return { rows, fields };
}

// ---------------------------------------------------------------- combined cells (SAP form)

const ITEM_EXTRAS = ['ItemDeliveryDate', 'PriceUnit', 'Currency'];
const QUANTITY_WITH_UNIT = /^([\d.,]+)\s+([A-Za-z][A-Za-z0-9]{0,9})$/;
const PRICE = /^(?:([A-Z]{3})\s+)?([\d.,]+)(?:\s+([A-Z]{3}))?(?:\s+[Pp]er\s+([\d.,]+)(?:\s+[A-Za-z][A-Za-z0-9]*)?)?$/;

/**
 * Split cells that carry two values: '1 PC' (quantity + unit, when there is no UoM column value),
 * '13.00 USD' / 'USD 13.00' (price + currency, optionally followed by 'per 1 PC').
 * The DeliveryDate table column becomes the item's delivery date. Unrecognised values are left
 * as they are, so the template rules report them.
 */
function splitCombinedValues(values) {
    const v = { ...values };
    if (v.DeliveryDate !== undefined) {
        v.ItemDeliveryDate = v.DeliveryDate;
        delete v.DeliveryDate;
    }
    const q = QUANTITY_WITH_UNIT.exec(v.Quantity ?? '');
    if (q && !v.UoM) [v.Quantity, v.UoM] = [q[1], q[2]];
    const p = PRICE.exec(v.UnitPrice ?? '');
    if (p && !(p[1] && p[3])) {
        v.UnitPrice = p[2];
        if (p[1] || p[3]) v.Currency = p[1] ?? p[3];
        if (p[4]) v.PriceUnit = p[4];
    }
    return v;
}

/**
 * Decimal separator of the document, from the prices ('13.00' -> '.', '13,00' -> ','), or null
 * if the prices do not show one unambiguously.
 */
function decimalSeparator(cells) {
    const found = new Set(cells.map((v) => /\d([.,])\d{2}$/.exec(v.UnitPrice ?? '')?.[1]).filter(Boolean));
    return found.size === 1 ? [...found][0] : null;
}

/** '1,000.5' -> '1000.5' ('.' decimals) or '1.000,5' -> '1000.5' (',' decimals); anything else unchanged. */
function normalizeNumber(s, decimal) {
    if (!s || !decimal) return s;
    const group = decimal === '.' ? ',' : '.';
    const grouped = new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+(?:\\${decimal}\\d+)?$`);
    const out = grouped.test(s) ? s.split(group).join('') : s;
    return decimal === ',' && /^\d+,\d+$/.test(out) ? out.replace(',', '.') : out;
}

/**
 * Pure part of the extraction (positioned text -> common PO structure), separated for testing.
 * @param {Array<Array<{x:number, y:number, w:number, size:number, text:string}>>} pages
 * @returns {import('./template.js').PurchaseOrderData}
 */
export function layoutToPurchaseOrder(pages) {
    const { rows, fields } = layoutToRows(pages);
    const cells = rows.map((r) => splitCombinedValues(r.values));
    const decimal = decimalSeparator(cells);
    for (const v of cells) for (const c of ['Quantity', 'UnitPrice', 'PriceUnit']) v[c] = normalizeNumber(v[c], decimal);

    // item-level values only the PDF has; added only when the document carries them
    const extras = ITEM_EXTRAS.filter((c) => cells.some((v) => v[c] != null));
    const columnNames = [...TEMPLATE_COLUMNS, ...extras];
    // header fields: table column if present, otherwise the labelled value; a DeliveryDate table
    // column is the item's date, the order's date comes from the label only
    const values = cells.map((v) => columnNames.map((c) => {
        if (c === 'DeliveryDate') return fields.DeliveryDate ?? null;
        return v[c] ?? (HEADER_FIELDS.includes(c) ? fields[c] ?? null : null);
    }));
    if (rows.length) {
        const missing = ['CustomerPO', 'PODate'].filter((c) => values.every((v) => v[columnNames.indexOf(c)] == null));
        if (missing.length) {
            const problems = missing.map((c) => ({
                field: c,
                message: `${FIELD_LABELS[c]} not found. Add '${FIELD_LABELS[c]}: <value>' above the item table.`,
            }));
            throw new ExtractionError(problems.map((p) => p.message).join(' '), problems, 'INVALID_TEMPLATE');
        }
    }

    const columns = Object.fromEntries(columnNames.map((c, i) => [c, i]));
    // rowNumber = n-th item row of the table (across pages)
    return rowsToPurchaseOrder(values.map((v, i) => ({ rowNumber: i + 1, values: v })), columns, METHOD);
}

/**
 * Deterministic extraction of a template PDF.
 * @param {Buffer} buffer
 * @returns {Promise<import('./template.js').PurchaseOrderData>}
 */
export async function extractPdfTemplate(buffer) {
    return layoutToPurchaseOrder(await readPdfText(buffer));
}

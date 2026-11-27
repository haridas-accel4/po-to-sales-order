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
 * - Table columns are matched by name, ignoring case, spaces and punctuation; their order is free
 *   and extra columns (e.g. "Total") are ignored. CustomerPO / PODate / DeliveryDate may also be
 *   table columns instead of labels.
 * - A table spanning several pages repeats its header row on each page (or continues with the
 *   column positions of the last header).
 * - Values follow the CSV/XLSX template rules (template.js): dates YYYY-MM-DD or DD.MM.YYYY,
 *   '.' as decimal separator, no thousands separators.
 *
 * The page text is read with its positions (pdf.js); rows are rebuilt from the y position and
 * values are assigned to columns from their x position under the table header.
 */

const MAX_PAGES = 50;
const TABLE_COLUMNS = ['Line', 'CustomerMaterial', 'Description', 'Quantity', 'UoM', 'UnitPrice'];
const HEADER_FIELDS = ['CustomerPO', 'PODate', 'DeliveryDate'];
const FIELD_LABELS = { CustomerPO: 'Customer PO', PODate: 'PO Date', DeliveryDate: 'Delivery Date' };

/** Header field labels, followed by ':' (the value follows on the same line). */
const LABEL = /\b(customer\s*po(?:\s*(?:no\.?|number|#))?|po\s*(?:no\.?|number|#)|purchase\s*order\s*(?:no\.?|number|#)|po\s*date|order\s*date|(?:requested\s*)?delivery\s*date)\s*:/gi;

const key = (s) => cleanText(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMN_BY_KEY = new Map(TEMPLATE_COLUMNS.map((c) => [key(c), c]));

function labelField(label) {
    const k = key(label);
    if (!k.includes('date')) return 'CustomerPO';
    return k.includes('delivery') ? 'DeliveryDate' : 'PODate';
}

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
    const missing = TABLE_COLUMNS.filter((c) => !found.includes(c));
    if (missing.length || duplicates.length) return { bands: null, found, missing, duplicates };

    // each column owns the x range from halfway to its left neighbour to halfway to its right neighbour
    const bands = cs.map((c, i) => ({
        column: columns[i],
        left: i === 0 ? -Infinity : (cs[i - 1].x + cs[i - 1].w + c.x) / 2,
        right: i === cs.length - 1 ? Infinity : (c.x + c.w + cs[i + 1].x) / 2,
    }));
    return { bands, found, missing, duplicates };
}

/** The band a piece belongs to: largest horizontal overlap (a zero-width piece: its start). */
function bandOf(piece, bands) {
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

/** Split a line into column values ({Line: '10', ...}); pieces under extra columns are dropped. */
function columnValues(line, bands) {
    const values = {};
    for (const p of line.pieces) {
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
                // a wrapped description: only description text, right below an item row
                const onlyDescription = Object.keys(values).length === 1 && values.Description;
                if (previous && onlyDescription && previous.y - line.y <= 1.6 * Math.max(line.size, previous.size)) {
                    rows.at(-1).values.Description += ` ${values.Description}`;
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
        const expected = `Expected a table header row with the columns: ${TABLE_COLUMNS.join(', ')}.`;
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

/**
 * Pure part of the extraction (positioned text -> common PO structure), separated for testing.
 * @param {Array<Array<{x:number, y:number, w:number, size:number, text:string}>>} pages
 * @returns {import('./template.js').PurchaseOrderData}
 */
export function layoutToPurchaseOrder(pages) {
    const { rows, fields } = layoutToRows(pages);

    // header fields: table column if present, otherwise the labelled value
    const values = rows.map((r) => TEMPLATE_COLUMNS.map((c) =>
        r.values[c] ?? (HEADER_FIELDS.includes(c) ? fields[c] ?? null : null)));
    if (rows.length) {
        const missing = ['CustomerPO', 'PODate'].filter((c) => values.every((v) => v[TEMPLATE_COLUMNS.indexOf(c)] == null));
        if (missing.length) {
            const problems = missing.map((c) => ({
                field: c,
                message: `${FIELD_LABELS[c]} not found. Add '${FIELD_LABELS[c]}: <value>' above the item table.`,
            }));
            throw new ExtractionError(problems.map((p) => p.message).join(' '), problems, 'INVALID_TEMPLATE');
        }
    }

    const columns = Object.fromEntries(TEMPLATE_COLUMNS.map((c, i) => [c, i]));
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

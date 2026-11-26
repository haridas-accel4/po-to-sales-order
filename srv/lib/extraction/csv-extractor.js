import { TextDecoder } from 'node:util';
import { parse, CsvError } from 'csv-parse/sync';
import { ExtractionError } from '../errors.js';
import { mapColumns, rowsToPurchaseOrder } from './template.js';

export const METHOD = 'CSV_TEMPLATE_V1';

/** Pick ';' or ',' (whichever occurs more often in the header line). */
function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0];
    const count = (ch) => firstLine.split(ch).length - 1;
    return count(';') > count(',') ? ';' : ',';
}

/**
 * Deterministic extraction of a template CSV (UTF-8, ',' or ';' separated).
 * @param {Buffer} buffer
 * @returns {import('./template.js').PurchaseOrderData}
 */
export function extractCsv(buffer) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new ExtractionError('The CSV file is not valid UTF-8 text. Save it as "CSV UTF-8".', [], 'INVALID_ENCODING');
    }
    text = text.replace(/^\uFEFF/, '');

    let records;
    try {
        records = parse(text, {
            delimiter: detectDelimiter(text),
            skip_empty_lines: true,
            trim: true,
            info: true,
        });
    } catch (e) {
        if (e instanceof CsvError) {
            const line = e.lines ?? e.info?.lines;
            throw new ExtractionError(`The CSV file could not be parsed${line ? ` (line ${line})` : ''}: ${e.message}`, [], 'INVALID_CSV');
        }
        throw e;
    }

    if (records.length === 0) throw new ExtractionError('The CSV file is empty.', [], 'NO_ITEMS');
    const [headerRec, ...dataRecs] = records;
    const columns = mapColumns(headerRec.record);
    const rows = dataRecs.map(({ record, info }) => ({ rowNumber: info.lines, values: record }));
    return rowsToPurchaseOrder(rows, columns, METHOD);
}

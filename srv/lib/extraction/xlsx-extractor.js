import ExcelJS from 'exceljs';
import { ExtractionError } from '../errors.js';
import { mapColumns, rowsToPurchaseOrder } from './template.js';

export const METHOD = 'XLSX_TEMPLATE_V1';

/** Reduce an ExcelJS cell value (rich text, formula, hyperlink, ...) to a plain value. */
function plainValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date || typeof value !== 'object') return value;
    if ('result' in value) return plainValue(value.result);          // formula
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return plainValue(value.text);              // hyperlink
    if ('error' in value) return null;                               // #N/A etc.
    return String(value);
}

/**
 * Deterministic extraction of a template workbook. Uses the first worksheet,
 * with the header in its first non-empty row.
 * @param {Buffer} buffer
 * @returns {Promise<import('./template.js').PurchaseOrderData>}
 */
export async function extractXlsx(buffer) {
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch (e) {
        throw new ExtractionError(`The XLSX file could not be opened: ${e.message}`, [], 'INVALID_XLSX');
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ExtractionError('The XLSX file contains no worksheet.', [], 'NO_ITEMS');

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const values = [];
        for (let c = 1; c <= row.cellCount; c++) values.push(plainValue(row.getCell(c).value));
        rows.push({ rowNumber, values });
    });
    if (rows.length === 0) throw new ExtractionError(`Worksheet '${sheet.name}' is empty.`, [], 'NO_ITEMS');

    const [headerRow, ...dataRows] = rows;
    const columns = mapColumns(headerRow.values);
    return rowsToPurchaseOrder(dataRows, columns, METHOD);
}

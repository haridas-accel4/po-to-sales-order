import ExcelJS from 'exceljs';
import { ExtractionError } from '../errors.js';
import { extractCsv } from './csv-extractor.js';
import { extractXlsx, plainValue } from './xlsx-extractor.js';
import { extractPdf } from './pdf-extractor.js';
import { readPdfText, pagesToText } from './pdf-template-extractor.js';

/**
 * Single entry point for extraction, independent of how the file arrived
 * (upload, e-mail, ...).
 * @param {{fileType:string, buffer:Buffer, config:object}} input
 * @returns {Promise<import('./template.js').PurchaseOrderData>}
 */
export async function extractPurchaseOrder({ fileType, buffer, config }) {
    switch (fileType) {
        case 'csv':  return extractCsv(buffer);
        case 'xlsx': return extractXlsx(buffer);
        case 'pdf':  return extractPdf(buffer, config?.pdfExtraction);
        default:     throw new ExtractionError(`No extractor for file type '${fileType}'.`, [], 'UNSUPPORTED_FILE_TYPE');
    }
}

/**
 * All readable text of a document (not only the template fields), e.g. to find who sent it.
 * Never throws: a file that cannot be read yields '' (extraction reports the problem).
 * @param {{fileType:string, buffer:Buffer}} input
 * @returns {Promise<string>}
 */
export async function extractDocumentText({ fileType, buffer }) {
    try {
        if (fileType === 'csv') return buffer.toString('utf8');
        if (fileType === 'pdf') return pagesToText(await readPdfText(buffer));
        if (fileType === 'xlsx') {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(buffer);
            const lines = [];
            for (const sheet of workbook.worksheets) {
                sheet.eachRow({ includeEmpty: false }, (row) => {
                    const values = [];
                    row.eachCell({ includeEmpty: false }, (cell) => values.push(plainValue(cell.value)));
                    lines.push(values.filter((v) => v !== null && v !== undefined).map(String).join('\t'));
                });
            }
            return lines.join('\n');
        }
    } catch {
        // unreadable file: no text to search
    }
    return '';
}

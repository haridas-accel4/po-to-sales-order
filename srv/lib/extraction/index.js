import { ExtractionError } from '../errors.js';
import { extractCsv } from './csv-extractor.js';
import { extractXlsx } from './xlsx-extractor.js';
import { extractPdf } from './pdf-extractor.js';

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

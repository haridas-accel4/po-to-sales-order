import { ExtractionNotConfiguredError } from '../errors.js';
import { extractPdfTemplate } from './pdf-template-extractor.js';

/**
 * PDF extraction, by provider (cds.po2so.pdfExtraction.provider):
 *
 *   template     (default) deterministic reading of PDFs in the fixed PO template,
 *                see pdf-template-extractor.js
 *   none         PDFs are stored but not read
 *   document-ai | gen-ai-hub   reserved for AI extraction of any layout (not implemented)
 *
 * Every provider must resolve to the common PurchaseOrderData structure (see template.js)
 * with a realistic `extraction.confidence` (0..1), so low-confidence results are routed to
 * NEEDS_REVIEW. The extractor only *proposes* data; mapping, validation and the decision to
 * create a Sales Order stay in the deterministic pipeline.
 *
 * @param {Buffer} buffer
 * @param {{provider:string}} config  cds.po2so.pdfExtraction
 * @returns {Promise<import('./template.js').PurchaseOrderData>}
 */
export async function extractPdf(buffer, config) {
    const provider = config?.provider ?? 'template';
    if (provider === 'template') return extractPdfTemplate(buffer);
    if (provider === 'none') {
        throw new ExtractionNotConfiguredError(
            'PDF extraction is not configured. The original file has been stored. ' +
            'Set cds.po2so.pdfExtraction.provider = "template" to read PDFs in the PO template ' +
            'and call reprocess(), or upload the PO using the CSV/XLSX template.'
        );
    }
    throw new ExtractionNotConfiguredError(
        `PDF extraction provider '${provider}' is not implemented yet. The original file has been stored; ` +
        'call reprocess() once the provider is available, or upload the PO using the CSV/XLSX template.'
    );
}

import { ExtractionNotConfiguredError } from '../errors.js';

export const METHOD = 'PDF';

/**
 * PDF extraction interface.
 *
 * PDFs will be extracted by SAP Document AI or SAP Generative AI Hub in a later
 * phase. An implementation must resolve to the common PurchaseOrderData
 * structure (see template.js) with a realistic `extraction.confidence`
 * (0..1) so low-confidence results are routed to NEEDS_REVIEW.
 *
 * The extractor only *proposes* data; mapping, validation and the decision to
 * create a Sales Order stay in the deterministic pipeline.
 *
 * @param {Buffer} _buffer
 * @param {{provider:string}} config  cds.po2so.pdfExtraction
 * @returns {Promise<import('./template.js').PurchaseOrderData>}
 */
export async function extractPdf(_buffer, config) {
    const provider = config?.provider ?? 'none';
    if (provider === 'none') {
        throw new ExtractionNotConfiguredError(
            'PDF extraction is not configured. The original file has been stored. ' +
            'Configure an extraction provider (cds.po2so.pdfExtraction.provider = "document-ai" or "gen-ai-hub") ' +
            'and call reprocess(), or upload the PO using the CSV/XLSX template.'
        );
    }
    throw new ExtractionNotConfiguredError(
        `PDF extraction provider '${provider}' is not implemented yet. The original file has been stored; ` +
        'call reprocess() once the provider is available, or upload the PO using the CSV/XLSX template.'
    );
}

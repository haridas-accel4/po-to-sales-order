import cds from '@sap/cds';

const DEFAULTS = {
    /** Maximum decoded file size in bytes (5 MB). */
    maxFileSize: 5 * 1024 * 1024,
    /** Orders whose extraction confidence is below this go to NEEDS_REVIEW. */
    minExtractionConfidence: 0.9,
    /** PDF extraction provider: none | document-ai | gen-ai-hub (later phase). */
    pdfExtraction: { provider: 'none' },
    /** Post VALIDATED orders to SAP right after intake (upload / e-mail). */
    autoPost: true,
    /** SAP sales order type used for every order (standard order in most tenants). */
    salesOrderType: 'OR',
};

/** Intake settings, overridable via `cds.po2so` in package.json / .cdsrc.json. */
export function getConfig() {
    const env = cds.env.po2so ?? {};
    return {
        ...DEFAULTS,
        ...env,
        pdfExtraction: { ...DEFAULTS.pdfExtraction, ...(env.pdfExtraction ?? {}) },
    };
}

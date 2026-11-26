/**
 * Invisible formatting characters that String.prototype.trim() does not remove,
 * but which commonly leak into identifiers copied from ERP systems, PDFs or
 * spreadsheets: soft hyphen, zero-width space / non-joiner / joiner, word joiner
 * and byte-order mark / zero-width no-break space.
 */
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Remove invisible characters and surrounding whitespace. */
export const cleanText = (value) => String(value ?? '').replace(INVISIBLE_CHARS, '').trim();

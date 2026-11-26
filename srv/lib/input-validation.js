/**
 * Service-level input checks for reviewer corrections (PATCH / $batch).
 * Independent of the extraction pipeline, which validates file content itself.
 */

/** Header date fields a reviewer may change on InboundOrders. */
export const ORDER_DATE_FIELDS = ['poDate', 'requestedDeliveryDate'];

/**
 * Fields that must never be changed through the API (in addition to the CDS
 * @readonly / @Core.Immutable annotations, which CAP enforces by silently
 * dropping them). Requests containing them are rejected explicitly so a client
 * never assumes such a change succeeded.
 */
export const PROTECTED_ORDER_FIELDS = ['file', 'file_ID', 'events', 'issues'];
export const PROTECTED_ITEM_FIELDS = ['parent', 'parent_ID'];

/**
 * True for a real calendar date in ISO format YYYY-MM-DD.
 * CAP's Date type only checks the format, so e.g. 2027-02-30 would be stored.
 */
export function isValidCalendarDate(value) {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Validate the date fields present in an update payload. null clears a date and is allowed.
 * @returns {Array<{field:string, message:string}>}
 */
export function invalidDates(data, fields = ORDER_DATE_FIELDS) {
    const errors = [];
    for (const field of fields) {
        if (!(field in (data ?? {})) || data[field] === null) continue;
        if (!isValidCalendarDate(data[field])) {
            errors.push({ field, message: `'${data[field]}' is not a valid calendar date (expected YYYY-MM-DD).` });
        }
    }
    return errors;
}

/** Names of protected fields contained in a payload. */
export function protectedFieldsIn(data, fields) {
    return fields.filter((f) => data && Object.hasOwn(data, f));
}

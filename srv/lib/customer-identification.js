import { cleanText } from './text.js';

/**
 * Customer identification for POs that arrive without a customer (e-mail, upload without one).
 *
 * Each customer has a list of identifiers (Customers.identifiers): values that appear on its POs
 * or e-mails, e.g. our supplier number in the customer's system ("Supplier ID: 0010411010" on an
 * SAP PO), the customer's VAT number, company name or e-mail domain. The identifiers of all
 * active customers are searched in
 *
 *   1. the attachment's text (the whole document, not only the item table), then
 *   2. the e-mail: sender, subject and body.
 *
 * A customer is only assigned when exactly one customer matches, and the attachment decides
 * over the e-mail: if the attachment matches one customer that one is taken (an e-mail body
 * may mention others, e.g. in quoted replies); if it matches several, the PO goes to review
 * and the e-mail is not consulted. Nothing is guessed: no match or several -> review.
 *
 * Matching ignores case and tolerates spaces, dots, dashes and slashes inside the value
 * ('DE 154 512 324' finds 'DE154512324' and vice versa), but a value must stand on its own:
 * '10411010' does not match inside '0010411010'.
 */

/** Shortest identifier (letters and digits counted) - shorter values match too much text. */
export const MIN_IDENTIFIER_LENGTH = 4;
export const MAX_IDENTIFIER_LENGTH = 100;
const MAX_TEXT = 500_000;

const alnum = (s) => [...cleanText(s).toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch));

/** Split the stored identifier list (';' or new line separated) into distinct values. */
export function parseIdentifiers(value) {
    const seen = new Set();
    return String(value ?? '').split(/[;\r\n]+/).map(cleanText).filter((v) => {
        const k = normalizeIdentifier(v);
        if (!v || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Comparison key of an identifier: letters and digits only, lower case. */
export const normalizeIdentifier = (value) => alnum(value).join('');

/** Problems with an identifier list, for the customer maintenance. */
export function identifierProblems(value) {
    return parseIdentifiers(value).flatMap((v) => {
        if (alnum(v).length < MIN_IDENTIFIER_LENGTH) {
            return [`Identifier '${v}' is too short; use at least ${MIN_IDENTIFIER_LENGTH} letters or digits so it cannot match unrelated text.`];
        }
        if (v.length > MAX_IDENTIFIER_LENGTH) return [`Identifier '${v.slice(0, 30)}...' is longer than ${MAX_IDENTIFIER_LENGTH} characters.`];
        return [];
    });
}

function matcher(identifier) {
    const chars = alnum(identifier); // letters and digits only: nothing to escape
    if (chars.length < MIN_IDENTIFIER_LENGTH) return null;
    const body = chars.join('[\\s.\\-/]*');
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Customers (active, with identifiers) whose identifiers occur in the text: [{customerId, identifier}]. */
export function matchCustomers(text, customers) {
    const haystack = cleanText(text).slice(0, MAX_TEXT);
    if (!haystack) return [];
    const hits = [];
    for (const c of customers ?? []) {
        if (c.active === false) continue;
        const identifier = parseIdentifiers(c.identifiers).find((v) => matcher(v)?.test(haystack));
        if (identifier) hits.push({ customerId: c.customerId, identifier });
    }
    return hits;
}

const where = { DOCUMENT: 'the attachment', EMAIL: 'the e-mail' };
const list = (hits) => hits.map((h) => `${h.customerId} ('${h.identifier}')`).join(', ');

/**
 * Identify the customer of a PO.
 * @param {{documentText?:string, emailText?:string}} sources
 * @param {Array<{customerId:string, identifiers:string, active?:boolean}>} customers
 * @returns {{customerId:string|null, source:'DOCUMENT'|'EMAIL'|null, matches:Array, message:string}}
 */
export function identifyCustomer({ documentText = '', emailText = '' }, customers) {
    for (const source of ['DOCUMENT', 'EMAIL']) {
        const matches = matchCustomers(source === 'DOCUMENT' ? documentText : emailText, customers);
        if (matches.length === 1) {
            const [m] = matches;
            return { customerId: m.customerId, source, matches, message: `Customer ${m.customerId} identified from ${where[source]} ('${m.identifier}').` };
        }
        if (matches.length > 1) {
            return {
                customerId: null, source, matches,
                message: `Customer not identified: ${where[source]} matches several customers: ${list(matches)}. Set the customer and revalidate.`,
            };
        }
    }
    return {
        customerId: null, source: null, matches: [],
        message: `Customer not identified: no customer identifier found in ${emailText ? 'the attachment or the e-mail' : 'the document'}. ` +
            'Set the customer and revalidate, or add an identifier to the customer.',
    };
}

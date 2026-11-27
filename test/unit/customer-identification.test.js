import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyCustomer, matchCustomers, parseIdentifiers, identifierProblems, normalizeIdentifier } from '../../srv/lib/customer-identification.js';

const CUSTOMERS = [
    { customerId: 'ACME', identifiers: '0010411010\nDE154512324' },
    { customerId: 'GLOBEX', identifiers: 'Globex Corporation; globex.example' },
    { customerId: 'OLD', identifiers: 'Initech GmbH', active: false },
    { customerId: 'NONE', identifiers: null },
];
const SAP_PO = 'Purchase Order: 4500000227\nSupplier ID:\t0010411010\nVAT No.:\tDE154512324';

describe('customer identification', () => {
    test('identifier lists: ; or line separated, trimmed, duplicates (ignoring case/punctuation) removed', () => {
        assert.deepEqual(parseIdentifiers(' 0010411010 ;\r\nDE 154 512 324\nde154512324;; '), ['0010411010', 'DE 154 512 324']);
        assert.deepEqual(parseIdentifiers(null), []);
        assert.equal(normalizeIdentifier('DE 154.512-324'), 'de154512324');
    });

    test('rejects identifiers that are too short or too long', () => {
        assert.deepEqual(identifierProblems('ACME Corp\n0010411010'), []);
        assert.match(identifierProblems('A-1')[0], /too short/);
        assert.match(identifierProblems('X'.repeat(101))[0], /longer than 100/);
    });

    test('finds identifiers as whole values, ignoring case, spaces and punctuation', () => {
        assert.deepEqual(matchCustomers(SAP_PO, CUSTOMERS), [{ customerId: 'ACME', identifier: '0010411010' }]);
        assert.equal(matchCustomers('VAT: de 154 512 324', CUSTOMERS)[0]?.customerId, 'ACME');
        assert.equal(matchCustomers('From: Jane <jane@globex.example>', CUSTOMERS)[0]?.customerId, 'GLOBEX');
        assert.equal(matchCustomers('GLOBEX  CORPORATION, Springfield', CUSTOMERS)[0]?.customerId, 'GLOBEX');
        // part of a longer number / word is no match
        assert.deepEqual(matchCustomers('Order 90010411010 and DE1545123245', CUSTOMERS), []);
        assert.deepEqual(matchCustomers('see www.globex.examples.org', CUSTOMERS), []);
    });

    test('inactive customers and customers without identifiers are never matched', () => {
        assert.deepEqual(matchCustomers('Initech GmbH', CUSTOMERS), []);
    });

    test('the attachment decides; the e-mail is used only when the attachment names no customer', () => {
        let r = identifyCustomer({ documentText: SAP_PO, emailText: 'From: buyer@globex.example' }, CUSTOMERS);
        assert.deepEqual([r.customerId, r.source], ['ACME', 'DOCUMENT']);
        assert.match(r.message, /Customer ACME identified from the attachment \('0010411010'\)/);

        r = identifyCustomer({ documentText: 'PO 4711', emailText: 'From: buyer@globex.example\nPlease see the attached PO' }, CUSTOMERS);
        assert.deepEqual([r.customerId, r.source], ['GLOBEX', 'EMAIL']);
    });

    test('several customers or none -> not identified, with the reason', () => {
        let r = identifyCustomer({ documentText: `${SAP_PO}\nShip to: Globex Corporation`, emailText: '' }, CUSTOMERS);
        assert.equal(r.customerId, null);
        assert.match(r.message, /matches several customers: ACME \('0010411010'\), GLOBEX \('Globex Corporation'\)/);

        // ambiguous attachment: the e-mail is not consulted
        r = identifyCustomer({ documentText: `${SAP_PO} Globex Corporation`, emailText: 'jane@globex.example' }, CUSTOMERS);
        assert.equal(r.customerId, null);

        r = identifyCustomer({ documentText: 'PO 4711', emailText: 'Hello' }, CUSTOMERS);
        assert.deepEqual([r.customerId, r.source], [null, null]);
        assert.match(r.message, /no customer identifier found in the attachment or the e-mail/);
    });
});

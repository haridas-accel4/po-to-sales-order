import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi5Module, reviewLogicUrl } from '../support/load-ui5-module.js';

const logic = loadUi5Module(reviewLogicUrl);

const order = () => ({
    ID: 'o1', status: 'NEEDS_REVIEW', extractionMethod: 'CSV_TEMPLATE_V1',
    customerId: null, customerPoNumber: 'PO-1', poDate: '2027-01-15', requestedDeliveryDate: null,
    items: [
        { ID: 'i1', lineNumber: 10, customerMaterial: 'A', description: 'Bolt', quantity: '100.000', customerUom: 'PCS', material: 'TG11', sapUom: 'PC' },
        { ID: 'i2', lineNumber: 20, customerMaterial: 'X', description: null, quantity: '2.500', customerUom: 'DRUM', material: null, sapUom: null },
    ],
});
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('Review logic (frontend)', () => {
    test('toDraft keeps only editable fields and normalizes decimals', () => {
        const d = logic.toDraft(order());
        assert.deepEqual(d.header, { customerId: null, customerPoNumber: 'PO-1', poDate: '2027-01-15', requestedDeliveryDate: null });
        assert.deepEqual(d.items[1], { ID: 'i2', lineNumber: 20, customerMaterial: 'X', description: null, quantity: '2.5', customerUom: 'DRUM' });
        assert.ok(!('material' in d.items[0]) && !('sapUom' in d.items[0]));
    });

    test('no changes -> nothing to send', () => {
        const d = logic.toDraft(order());
        const c = logic.buildChanges(d, clone(d));
        assert.equal(c.count, 0);
        assert.deepEqual(logic.buildBatch('o1', c).requests, []);
    });

    test('only changed editable fields are sent; blanks become null; quantity is numeric', () => {
        const original = logic.toDraft(order());
        const draft = clone(original);
        draft.header.customerId = 'ACME';
        draft.header.customerPoNumber = '  PO-1  ';      // whitespace only -> unchanged
        draft.header.requestedDeliveryDate = '2027-02-01';
        draft.items[1].customerUom = 'PCS';
        draft.items[1].quantity = '2.50';                 // same value -> unchanged
        draft.items[0].description = '   ';               // cleared -> null
        draft.items[0].material = 'HACK';                 // not editable -> ignored
        draft.items[0].sapUom = 'HACK';
        draft.header.status = 'VALIDATED';                // not editable -> ignored

        const c = logic.buildChanges(original, draft);
        assert.deepEqual(c.header, { customerId: 'ACME', requestedDeliveryDate: '2027-02-01' });
        assert.deepEqual(c.items, [{ ID: 'i1', changes: { description: null } }, { ID: 'i2', changes: { customerUom: 'PCS' } }]);

        draft.items[1].quantity = '3';
        assert.deepEqual(logic.buildChanges(original, draft).items[1].changes, { quantity: 3, customerUom: 'PCS' });
    });

    test('buildBatch: one atomic group, PATCH only, no read-only fields', () => {
        const original = logic.toDraft(order());
        const draft = clone(original);
        draft.header.customerId = 'ACME';
        draft.items[1].customerUom = 'PCS';
        const { requests } = logic.buildBatch('o1', logic.buildChanges(original, draft));
        assert.deepEqual(requests.map((r) => [r.method, r.url, r.atomicityGroup]),
            [['PATCH', 'InboundOrders(o1)', 'review'], ['PATCH', 'InboundItems(i2)', 'review']]);
        const sentFields = requests.flatMap((r) => Object.keys(r.body));
        for (const f of sentFields) assert.ok([...logic.HEADER_FIELDS, ...logic.ITEM_FIELDS].includes(f), f);
    });

    test('validateDraft: quantity format, impossible dates, lengths', () => {
        const d = logic.toDraft(order());
        assert.equal(logic.validateDraft(d).count, 0);

        d.items[0].quantity = 'abc';
        d.items[1].quantity = '1.2345';
        d.header.poDate = '2027-02-30';
        d.header.customerPoNumber = 'X'.repeat(36);
        d.items[0].customerUom = 'TOO-LONG-UOM';
        const v = logic.validateDraft(d);
        assert.equal(v.count, 5);
        assert.ok(v.items.i1.quantity && v.items.i2.quantity && v.items.i1.customerUom);
        assert.ok(v.header.poDate && v.header.customerPoNumber);

        const ok = logic.toDraft(order());
        ok.items[0].quantity = '';
        assert.match(logic.validateDraft(ok).items.i1.quantity, /required/);
        ok.items[0].quantity = '0';                         // format OK; the backend flags <= 0
        assert.equal(logic.validateDraft(ok).count, 0);
        assert.equal(logic.validateDraft(logic.toDraft(order()), { requestedDeliveryDate: true }).header.requestedDeliveryDate, 'Enter a valid date.');
    });

    test('isValidIsoDate', () => {
        assert.ok(logic.isValidIsoDate('2028-02-29'));
        for (const s of ['2027-02-29', '2027-13-01', '27-01-01', '', null]) assert.ok(!logic.isValidIsoDate(s), String(s));
    });

    test('reviewState: CREATED and never-extracted orders are read-only', () => {
        assert.equal(logic.reviewState(order()).editable, true);
        assert.equal(logic.reviewState({ ...order(), status: 'FAILED' }).editable, true); // e.g. duplicate -> correct PO number
        assert.equal(logic.reviewState({ ...order(), status: 'CREATED' }).editable, false);
        assert.match(logic.reviewState({ ...order(), status: 'FAILED', extractionMethod: null }).reason, /upload it again/);
    });

    test('issueStates maps backend issues to header fields and item lines', () => {
        const s = logic.issueStates([
            { severity: 'ERROR', field: 'customerId', lineNumber: null, message: 'no customer' },
            { severity: 'WARNING', field: 'requestedDeliveryDate', lineNumber: null, message: 'no date' },
            { severity: 'WARNING', field: 'quantity', lineNumber: 20, message: 'w' },
            { severity: 'ERROR', field: 'customerUom', lineNumber: 20, message: 'unmapped' },
        ]);
        assert.deepEqual(s.header.customerId, { state: 'Error', text: 'no customer' });
        assert.equal(s.header.requestedDeliveryDate.state, 'Warning');
        assert.equal(s.lines[20].highlight, 'Error');
        assert.equal(s.lines[20].fields.customerUom.state, 'Error');
    });

    test('batchErrors extracts messages of failed requests', () => {
        assert.deepEqual(logic.batchErrors({ responses: [{ status: 200 }, { status: 400, body: { error: { message: 'bad' } } }, { status: 500 }] }),
            ['bad', 'HTTP 500']);
        assert.deepEqual(logic.batchErrors({ responses: [{ status: 200 }] }), []);
    });

    test('fieldLabel', () => {
        assert.equal(logic.fieldLabel('customerUom'), 'External UoM');
        assert.equal(logic.fieldLabel('Quantity'), 'Quantity (file)');
        assert.equal(logic.fieldLabel('unknownField'), 'unknownField');
        assert.equal(logic.fieldLabel(null), '');
    });
});

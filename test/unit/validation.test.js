import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequiredFields, validateQuantities, validateConfidence, determineStatus } from '../../srv/lib/validation.js';
import { mapItems } from '../../srv/lib/mapping.js';

const header = { customerPoNumber: 'P1', poDate: '2027-01-01', requestedDeliveryDate: '2027-01-10' };
const item = (o = {}) => ({ lineNumber: 10, customerMaterial: 'A', customerUom: 'PCS', quantity: 1, ...o });
const codes = (issues) => issues.map((i) => `${i.severity}:${i.code}`);

describe('Validation rules', () => {
    test('complete order has no issues and is VALIDATED', () => {
        const issues = [...validateRequiredFields(header, [item()]), ...validateQuantities([item()]), ...validateConfidence(1, 0.9)];
        assert.deepEqual(issues, []);
        assert.equal(determineStatus(issues), 'VALIDATED');
    });

    test('required fields', () => {
        assert.deepEqual(codes(validateRequiredFields({}, [])),
            ['ERROR:REQUIRED_FIELD', 'ERROR:REQUIRED_FIELD', 'WARNING:NO_DELIVERY_DATE', 'ERROR:NO_ITEMS']);
        assert.deepEqual(codes(validateRequiredFields({ ...header, requestedDeliveryDate: '2026-12-31' }, [item()])),
            ['ERROR:INVALID_DELIVERY_DATE']);
        assert.deepEqual(codes(validateRequiredFields(header, [item(), item({ customerMaterial: null, customerUom: '' })])),
            ['ERROR:DUPLICATE_LINE', 'ERROR:REQUIRED_FIELD', 'WARNING:NO_UOM']);
    });

    test('warnings alone do not block', () => {
        assert.equal(determineStatus(validateRequiredFields({ ...header, requestedDeliveryDate: null }, [item()])), 'VALIDATED');
    });

    test('quantities', () => {
        assert.deepEqual(validateQuantities([item({ quantity: '2.500' }), item({ quantity: 0.001 })]), []);
        const issues = validateQuantities([item({ quantity: 0 }), item({ quantity: -1 }), item({ quantity: 'x' }),
            item({ quantity: null }), item({ quantity: 1.0001 })]);
        assert.equal(issues.length, 5);
        assert.ok(issues.every((i) => i.code === 'INVALID_QUANTITY'));
    });

    test('extraction confidence', () => {
        assert.deepEqual(validateConfidence(0.95, 0.9), []);
        assert.deepEqual(codes(validateConfidence(0.5, 0.9)), ['ERROR:LOW_CONFIDENCE']);
        assert.deepEqual(codes(validateConfidence(null, 0.9)), ['ERROR:LOW_CONFIDENCE']);
    });

    test('material and UoM mapping (case-insensitive, unknown -> error)', () => {
        const { items, issues } = mapItems(
            [item({ customerMaterial: 'acme-1', customerUom: 'pcs' }), item({ lineNumber: 20, customerMaterial: 'NOPE', customerUom: 'DRUM' })],
            new Map([['ACME-1', 'TG11']]), new Map([['PCS', 'PC']]));
        assert.deepEqual(items.map((i) => [i.material, i.sapUom]), [['TG11', 'PC'], [null, null]]);
        assert.deepEqual(codes(issues), ['ERROR:MATERIAL_UNMAPPED', 'ERROR:UOM_UNMAPPED']);
        assert.equal(issues[0].lineNumber, 20);
    });

    test('material mapping ignores invisible characters (e.g. zero-width space from S/4 exports)', () => {
        const { items, issues } = mapItems([item({ customerMaterial: 'UP-FAN-AFO-001\u200B', customerUom: '\uFEFFPCS' })],
            new Map([['UP-FAN-AFO-001', 'TG11']]), new Map([['PCS', 'PC']]));
        assert.deepEqual(items.map((i) => [i.material, i.sapUom]), [['TG11', 'PC']]);
        assert.deepEqual(issues, []);
    });

    test('item delivery date and price unit', () => {
        assert.deepEqual(validateRequiredFields(header, [item({ requestedDeliveryDate: '2027-01-10', priceUnit: 100 })]), []);
        assert.deepEqual(validateRequiredFields(header, [item({ requestedDeliveryDate: null, priceUnit: null })]), []);
        // only the order's date reaches SAP: a different item date is reported
        assert.deepEqual(codes(validateRequiredFields(header, [item({ requestedDeliveryDate: '2027-01-01' })])), ['WARNING:ITEM_DELIVERY_DATE']);
        const issues = validateRequiredFields(header, [item({ requestedDeliveryDate: '2026-12-31' }), item({ lineNumber: 20, priceUnit: 0 }), item({ lineNumber: 30, priceUnit: 1.5 })]);
        assert.deepEqual(codes(issues), ['ERROR:INVALID_DELIVERY_DATE', 'ERROR:INVALID_PRICE_UNIT', 'ERROR:INVALID_PRICE_UNIT']);
        assert.deepEqual(issues.map((i) => i.lineNumber), [10, 20, 30]);
    });

    test('material mapping errors are suppressed when the customer is unknown', () => {
        const { issues } = mapItems([item()], new Map(), new Map([['PCS', 'PC']]), { customerKnown: false });
        assert.deepEqual(issues, []);
    });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi5Module } from '../support/load-ui5-module.js';

const logic = loadUi5Module(new URL('../../app/sales-order/webapp/model/mappingLogic.js', import.meta.url));

describe('Mapping maintenance logic (frontend)', () => {
    test('key predicates (single, compound, quotes and special characters escaped)', () => {
        assert.equal(logic.keyPredicate('customers', { customerId: 'ACME' }), "Customers('ACME')");
        assert.equal(logic.keyPredicate('uoms', { externalUom: 'PCS' }), "UomMappings('PCS')");
        assert.equal(logic.keyPredicate('materials', { soldToParty: '0010100001', customerMaterial: "BOLT/10 O'X" }),
            "MaterialMappings(soldToParty='0010100001',customerMaterial='BOLT%2F10%20O''X')");
    });

    test('new and existing drafts', () => {
        assert.deepEqual(logic.newDraft('uoms'), { externalUom: '', sapUnit: '' });
        assert.deepEqual(logic.newDraft('uoms', { externalUom: 'DRUM' }), { externalUom: 'DRUM', sapUnit: '' });
        assert.deepEqual(logic.draftFromRow('materials', { soldToParty: '1', customerMaterial: 'A', material: 'M', description: null, active: true }),
            { soldToParty: '1', customerMaterial: 'A', material: 'M', description: '' });
    });

    test('validateDraft: required fields and max lengths per type', () => {
        assert.deepEqual(Object.keys(logic.validateDraft('customers', logic.newDraft('customers'))).sort(), ['customerId', 'customerName', 'soldToParty']);
        assert.deepEqual(Object.keys(logic.validateDraft('materials', { soldToParty: '1', customerMaterial: ' ', material: '' })).sort(), ['customerMaterial', 'material']);
        assert.match(logic.validateDraft('uoms', { externalUom: 'BOX', sapUnit: 'CARTON' }).sapUnit, /maximum 3/);
        assert.deepEqual(logic.validateDraft('uoms', { externalUom: 'BOX', sapUnit: 'BOX' }), {});
    });

    test('buildPayload: create sends trimmed non-blank fields', () => {
        assert.deepEqual(logic.buildPayload('customers', { customerId: ' NEW ', customerName: 'New Co', soldToParty: '1', salesOrganization: '', distributionChannel: '', division: '' }),
            { customerId: 'NEW', customerName: 'New Co', soldToParty: '1' });
    });

    test('buildPayload: update sends only changed non-key fields, never keys', () => {
        const original = { soldToParty: '1', customerMaterial: 'A', material: 'TG11', description: 'Bolt', active: true };
        assert.deepEqual(logic.buildPayload('materials', { soldToParty: 'X', customerMaterial: 'B', material: 'TG12', description: 'Bolt' }, original), { material: 'TG12' });
        assert.deepEqual(logic.buildPayload('materials', { soldToParty: '1', customerMaterial: 'A', material: 'TG11', description: '' }, original), { description: null });
        assert.deepEqual(logic.buildPayload('uoms', { externalUom: 'PCS', sapUnit: 'PC' }, { externalUom: 'PCS', sapUnit: 'PC' }), {});
    });

    test('filterRows: case-insensitive, all terms, includes customer name for materials', () => {
        const rows = [
            { soldToParty: '0010100001', customerMaterial: 'ACME-BOLT-10', material: 'TG11', description: 'Bolt', customerName: 'ACME Industries' },
            { soldToParty: '0010100002', customerMaterial: 'GX-1000', material: 'TG11', description: 'Bolt', customerName: 'Globex' },
        ];
        assert.equal(logic.filterRows('materials', rows, '').length, 2);
        assert.deepEqual(logic.filterRows('materials', rows, 'globex').map((r) => r.customerMaterial), ['GX-1000']);
        assert.deepEqual(logic.filterRows('materials', rows, 'tg11 acme').map((r) => r.customerMaterial), ['ACME-BOLT-10']);
    });

    test('soldToOptions: active customers only, one entry per sold-to party', () => {
        const opts = logic.soldToOptions([
            { customerId: 'A', customerName: 'A Ltd', soldToParty: '1', active: true },
            { customerId: 'A2', customerName: 'A second ID', soldToParty: '1', active: true },
            { customerId: 'B', customerName: 'B Inc', soldToParty: '2', active: false },
            { customerId: 'C', customerName: 'C AG', soldToParty: '', active: true },
        ]);
        assert.deepEqual(opts, [{ key: '1', text: '1', additionalText: 'A Ltd' }]);
    });

    test('draftFromIssue: material and UoM issues prefill and lock the key fields', () => {
        const order = { soldToParty: '0010100001' };
        const item = { lineNumber: 20, customerMaterial: 'NEW-PART', description: 'Part', customerUom: 'DRUM' };
        assert.deepEqual(logic.draftFromIssue({ code: 'MATERIAL_UNMAPPED', lineNumber: 20 }, order, item), {
            type: 'materials',
            draft: { soldToParty: '0010100001', customerMaterial: 'NEW-PART', material: '', description: 'Part' },
            locked: ['soldToParty', 'customerMaterial'],
        });
        assert.deepEqual(logic.draftFromIssue({ code: 'UOM_UNMAPPED', lineNumber: 20 }, order, item),
            { type: 'uoms', draft: { externalUom: 'DRUM', sapUnit: '' }, locked: ['externalUom'] });
        // not offered: other issues, unknown customer, missing item
        assert.equal(logic.draftFromIssue({ code: 'INVALID_QUANTITY' }, order, item), null);
        assert.equal(logic.draftFromIssue({ code: 'MATERIAL_UNMAPPED' }, { soldToParty: null }, item), null);
        assert.equal(logic.draftFromIssue({ code: 'UOM_UNMAPPED' }, order, undefined), null);
    });

    test('errorTargets: single error and details', () => {
        assert.deepEqual(logic.errorTargets({ message: 'dup', target: 'externalUom' }), { externalUom: 'dup' });
        assert.deepEqual(logic.errorTargets({ message: 'x', details: [{ target: 'a', message: 'A' }, { target: 'in/b', message: 'B' }] }), { a: 'A', b: 'B' });
        assert.deepEqual(logic.errorTargets({ message: 'no target' }), {});
    });

    test('revalidation summary and details', () => {
        const result = {
            checked: 3, changed: 2, validated: 2, needsReview: 1, failed: 0, errors: 1, skipped: 1,
            results: [
                { customerPoNumber: 'P1', previousStatus: 'NEEDS_REVIEW', status: 'VALIDATED' },
                { customerPoNumber: 'P2', previousStatus: 'NEEDS_REVIEW', status: 'NEEDS_REVIEW' },
                { customerPoNumber: 'P3', previousStatus: 'NEEDS_REVIEW', status: 'NEEDS_REVIEW', error: 'Revalidation failed: boom' },
            ],
        };
        const text = logic.revalidationSummary(result);
        assert.match(text, /Checked 3 open order\(s\): 2 validated, 1 need review, 0 failed/);
        assert.match(text, /1 order\(s\) could not be revalidated/);
        assert.match(text, /1 open order\(s\) were skipped/);
        assert.equal(logic.revalidationDetails(result), 'P1: NEEDS_REVIEW -> VALIDATED\nP3: NEEDS_REVIEW -> NEEDS_REVIEW (Revalidation failed: boom)');
    });
});

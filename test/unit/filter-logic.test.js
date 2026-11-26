import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi5Module } from '../support/load-ui5-module.js';

const logic = loadUi5Module(new URL('../../app/sales-order/webapp/model/filterLogic.js', import.meta.url));

// Rows as built by App.controller#_toRecord
const row = (o) => ({
    poNumber: '', fileName: '', customer: '', customerId: '', soldToParty: '',
    status: 'VALIDATED', fileType: 'CSV', poDateIso: '2027-01-15', ...o,
});
const RECORDS = [
    row({ poNumber: 'PO-2027-0001', fileName: 'sample-po.csv', customer: 'ACME Industries Ltd. (ACME)', customerId: 'ACME', soldToParty: '0010100001' }),
    row({ poNumber: 'PO-2027-0002', fileName: 'march-order.xlsx', fileType: 'XLSX', customer: 'Globex Corporation (GLOBEX)', customerId: 'GLOBEX', soldToParty: '0010100002', status: 'NEEDS_REVIEW', poDateIso: '2027-03-01' }),
    row({ poNumber: 'GX-778', fileName: 'globex-weekly.csv', customer: 'Globex Corporation (GLOBEX)', customerId: 'GLOBEX', soldToParty: '0010100002', poDateIso: '2027-02-10' }),
    row({ poNumber: 'PO-UNMAINTAINED', fileName: 'unknown.csv', customer: 'NOBODY', customerId: 'NOBODY', status: 'NEEDS_REVIEW' }),
    row({ poNumber: '', fileName: 'broken.xlsx', fileType: 'XLSX', status: 'FAILED', poDateIso: '' }),
];
const search = (q, filters = {}, tab = 'upload') =>
    logic.applyFilters(RECORDS, { ...logic.emptyFilters(), ...filters, search: q }, tab).map((r) => r.fileName);

describe('Filter and search logic (frontend)', () => {
    test('empty search and filters return everything on the upload tab', () => {
        assert.equal(search('').length, RECORDS.length);
        assert.equal(logic.applyFilters(RECORDS, {}, 'upload').length, RECORDS.length);
    });

    test('search by customer PO number', () => {
        assert.deepEqual(search('PO-2027-0002'), ['march-order.xlsx']);
        assert.deepEqual(search('2027-000'), ['sample-po.csv', 'march-order.xlsx']);
    });

    test('search by original file name', () => {
        assert.deepEqual(search('march-order'), ['march-order.xlsx']);
        assert.deepEqual(search('.xlsx'), ['march-order.xlsx', 'broken.xlsx']);
        assert.deepEqual(search('broken'), ['broken.xlsx']); // also finds FAILED orders without PO number
    });

    test('search by customer name, customer ID and sold-to party', () => {
        assert.deepEqual(search('Industries'), ['sample-po.csv']);
        assert.deepEqual(search('GLOBEX'), ['march-order.xlsx', 'globex-weekly.csv']);
        assert.deepEqual(search('NOBODY'), ['unknown.csv']);           // ID of a customer that is not maintained
        assert.deepEqual(search('0010100001'), ['sample-po.csv']);     // sold-to party
    });

    test('matching is case-insensitive and ignores surrounding whitespace', () => {
        assert.deepEqual(search('  acme industries ltd.  '), ['sample-po.csv']);
        assert.deepEqual(search('po-2027-0001'), search('PO-2027-0001'));
        assert.deepEqual(search('MARCH-ORDER.XLSX'), ['march-order.xlsx']);
    });

    test('multiple terms must all match (in any searchable field)', () => {
        assert.deepEqual(search('globex weekly'), ['globex-weekly.csv']);
        assert.deepEqual(search('acme xlsx'), []);
    });

    test('no match returns an empty list', () => {
        assert.deepEqual(search('does-not-exist'), []);
    });

    test('search combines with the filter bar and the selected tab', () => {
        assert.deepEqual(search('globex', { status: 'NEEDS_REVIEW' }), ['march-order.xlsx']);
        assert.deepEqual(search('globex', { fileType: 'CSV' }), ['globex-weekly.csv']);
        assert.deepEqual(search('globex', { dateFrom: '2027-02-01', dateTo: '2027-02-28' }), ['globex-weekly.csv']);
        assert.deepEqual(search('globex', { poNumber: 'GX' }), ['globex-weekly.csv']);
        assert.deepEqual(search('csv', { customer: 'acme' }), ['sample-po.csv']);
        assert.deepEqual(search('globex', {}, 'exceptions'), ['march-order.xlsx']);
        assert.deepEqual(search('', {}, 'exceptions'), ['march-order.xlsx', 'unknown.csv', 'broken.xlsx']);
        assert.deepEqual(search('', {}, 'sales'), []);
    });

    test('search does not overwrite the PO number filter', () => {
        const filters = { ...logic.emptyFilters(), poNumber: 'PO-2027', search: 'globex' };
        assert.deepEqual(logic.applyFilters(RECORDS, filters, 'upload').map((r) => r.fileName), ['march-order.xlsx']);
        assert.equal(filters.poNumber, 'PO-2027');
        assert.equal(filters.search, 'globex');
    });

    test('existing filter bar behaviour is unchanged', () => {
        const f = (filters) => logic.applyFilters(RECORDS, { ...logic.emptyFilters(), ...filters }, 'upload').map((r) => r.fileName);
        assert.deepEqual(f({ customer: '0010100002' }), ['march-order.xlsx', 'globex-weekly.csv']);
        assert.deepEqual(f({ status: 'FAILED' }), ['broken.xlsx']);
        assert.deepEqual(f({ dateFrom: '2027-01-01' }).includes('broken.xlsx'), false); // no PO date -> excluded by a date range
    });

    test('Clear: emptyFilters resets search text and every filter value', () => {
        const cleared = logic.emptyFilters();
        assert.deepEqual(cleared, { search: '', poNumber: '', customer: '', status: '', fileType: '', dateFrom: '', dateTo: '' });
        assert.notEqual(logic.emptyFilters(), cleared, 'a fresh object every time');
        const applied = { search: 'globex', poNumber: 'X', customer: 'Y', status: 'FAILED', fileType: 'PDF', dateFrom: '2027-01-01', dateTo: '2027-12-31' };
        assert.deepEqual(search('', applied), []);
        assert.equal(logic.applyFilters(RECORDS, logic.emptyFilters(), 'upload').length, RECORDS.length);
    });

    test('date range validation', () => {
        assert.equal(logic.validateFilters({ dateFrom: '2027-02-01', dateTo: '2027-01-01' }), "'PO Date From' must not be after 'PO Date To'.");
        assert.equal(logic.validateFilters({ dateFrom: '2027-01-01', dateTo: '2027-01-01' }), null);
        assert.equal(logic.validateFilters(logic.emptyFilters()), null);
    });

    test('tab counts are unchanged (independent of filters)', () => {
        assert.deepEqual(logic.tabCounts(RECORDS), { processed: 4, salesOrders: 0, exceptions: 3 });
    });
});

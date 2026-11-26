import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi5Module } from '../support/load-ui5-module.js';

const logic = loadUi5Module(new URL('../../app/sales-order/webapp/model/listSettingsLogic.js', import.meta.url));
const filterLogic = loadUi5Module(new URL('../../app/sales-order/webapp/model/filterLogic.js', import.meta.url));

/** In-memory Storage stand-in (localStorage API subset). */
function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
    };
}
const throwingStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
};

const row = (o) => ({ poNumber: '', fileName: '', customer: '', poDateIso: '', createdAtIso: '', statusText: '', ...o });

describe('List settings: defaults and persistence', () => {
    test('defaults show every filter field and column, no sorting', () => {
        const d = logic.defaultSettings();
        assert.deepEqual(Object.keys(d.filterVisible), ['poNumber', 'customer', 'status', 'fileType', 'dateFrom', 'dateTo']);
        assert.ok(Object.values(d.filterVisible).every((v) => v === true));
        assert.equal(Object.keys(d.columnVisible).length, 9);
        assert.ok(Object.values(d.columnVisible).every((v) => v === true));
        assert.deepEqual(d.sort, []);
    });

    test('filter fields match the filter bar model (search is always shown)', () => {
        const filterKeys = Object.keys(filterLogic.emptyFilters()).filter((k) => k !== 'search');
        assert.deepEqual(logic.FILTER_FIELDS.map((f) => f.key), filterKeys);
    });

    test('save + load round trip', () => {
        const storage = memoryStorage();
        const s = logic.defaultSettings();
        s.filterVisible.customer = false;
        s.columnVisible.source = false;
        s.sort = [{ key: 'poNumber', descending: true }];
        assert.equal(logic.save(storage, s), true);
        assert.deepEqual(logic.load(storage), s);
        assert.equal(logic.clear(storage), true);
        assert.deepEqual(logic.load(storage), logic.defaultSettings());
    });

    test('load never throws: missing, corrupt or blocked storage fall back to defaults', () => {
        assert.deepEqual(logic.load(null), logic.defaultSettings());
        assert.deepEqual(logic.load(memoryStorage({ [logic.STORAGE_KEY]: '{not json' })), logic.defaultSettings());
        assert.deepEqual(logic.load(throwingStorage), logic.defaultSettings());
        assert.equal(logic.save(throwingStorage, logic.defaultSettings()), false);
        assert.equal(logic.clear(throwingStorage), false);
    });

    test('normalize drops unknown keys and invalid values and keeps at least one column', () => {
        const n = logic.normalize({
            filterVisible: { customer: false, bogus: false, status: 'no' },
            columnVisible: { fileName: false },
            sort: [{ key: 'poNumber', descending: 1 }, { key: 'poNumber' }, { key: 'nope' }, null],
        });
        assert.equal(n.filterVisible.customer, false);
        assert.equal(n.filterVisible.status, true, 'non-boolean ignored');
        assert.equal('bogus' in n.filterVisible, false);
        assert.equal(n.columnVisible.fileName, false);
        assert.deepEqual(n.sort, [{ key: 'poNumber', descending: false }], 'duplicates / unknown columns dropped');

        const allHidden = Object.fromEntries(logic.COLUMNS.map((c) => [c.key, false]));
        assert.ok(Object.values(logic.normalize({ columnVisible: allHidden }).columnVisible).every(Boolean));
    });
});

describe('Adapt Filters', () => {
    test('panel data lists the optional filter fields with their visibility', () => {
        const s = logic.defaultSettings();
        s.filterVisible.dateTo = false;
        const data = logic.filterPanelData(s);
        assert.deepEqual(data.map((d) => d.label), ['Purchase Order', 'Customer', 'Status', 'File Type', 'PO Date From', 'PO Date To']);
        assert.deepEqual(data.find((d) => d.name === 'dateTo'), { name: 'dateTo', label: 'PO Date To', visible: false });
    });

    test('selection from the panel becomes the visibility map', () => {
        const items = logic.filterPanelData(logic.defaultSettings()).map((i) => ({ ...i, visible: i.name !== 'customer' }));
        const v = logic.visibilityFromPanel(items, logic.FILTER_FIELDS);
        assert.equal(v.customer, false);
        assert.equal(v.poNumber, true);
        assert.equal(logic.visibilityFromPanel([], logic.FILTER_FIELDS).customer, true, 'missing items stay shown');
    });

    test('hidden filter fields are cleared so they no longer filter the list', () => {
        const values = { ...filterLogic.emptyFilters(), search: 'acme', customer: 'GLOBEX', status: 'FAILED' };
        const visible = { ...logic.defaultSettings().filterVisible, customer: false };
        const result = logic.clearHiddenFilters(values, visible);
        assert.deepEqual(result, { ...values, customer: '' });
        assert.equal(values.customer, 'GLOBEX', 'input not mutated');
    });
});

describe('Table Settings: columns and sorting', () => {
    test('column panel data covers every table column', () => {
        assert.deepEqual(logic.columnPanelData(logic.defaultSettings()).map((c) => c.label),
            ['File Name', 'Customer', 'Purchase Order', 'PO Date', 'File Type', 'Source', 'Status', 'Sales Order', 'Created On']);
    });

    test('sort panel lists active sorts first; round trip through the panel', () => {
        const s = logic.defaultSettings();
        s.sort = [{ key: 'status', descending: true }, { key: 'poDate', descending: false }];
        const data = logic.sortPanelData(s);
        assert.deepEqual(data.slice(0, 2), [
            { name: 'status', label: 'Status', sorted: true, descending: true },
            { name: 'poDate', label: 'PO Date', sorted: true, descending: false },
        ]);
        assert.equal(data.length, logic.COLUMNS.length);
        assert.deepEqual(logic.sortFromPanel(data), s.sort);
    });

    test('sortRecords sorts by the column field (ISO dates for date columns), stable, empty values last', () => {
        const records = [
            row({ poNumber: 'PO-10', poDateIso: '2027-02-01', createdAtIso: '2026-01-02T00:00:00Z' }),
            row({ poNumber: 'PO-9', poDateIso: '2027-01-15', createdAtIso: '2026-01-03T00:00:00Z' }),
            row({ poNumber: '', poDateIso: '', createdAtIso: '2026-01-01T00:00:00Z' }),
        ];
        const po = (list) => list.map((r) => r.poNumber);
        assert.deepEqual(po(logic.sortRecords(records, [{ key: 'poNumber', descending: false }])), ['PO-9', 'PO-10', ''], 'numeric-aware');
        assert.deepEqual(po(logic.sortRecords(records, [{ key: 'poNumber', descending: true }])), ['', 'PO-10', 'PO-9']);
        assert.deepEqual(po(logic.sortRecords(records, [{ key: 'poDate', descending: false }])), ['PO-9', 'PO-10', '']);
        assert.deepEqual(po(logic.sortRecords(records, [{ key: 'createdOn', descending: true }])), ['PO-9', 'PO-10', '']);
        assert.deepEqual(po(logic.sortRecords(records, [])), ['PO-10', 'PO-9', ''], 'no sort keeps backend order');
        assert.notEqual(logic.sortRecords(records, []), records, 'returns a new array');
    });

    test('multi-column sort and sorting combined with filters', () => {
        const records = [
            row({ fileName: 'a', customer: 'ACME', statusText: 'Validated', fileType: 'CSV', status: 'VALIDATED' }),
            row({ fileName: 'b', customer: 'GLOBEX', statusText: 'Failed', fileType: 'CSV', status: 'FAILED' }),
            row({ fileName: 'c', customer: 'ACME', statusText: 'Failed', fileType: 'XLSX', status: 'FAILED' }),
            row({ fileName: 'd', customer: 'ACME', statusText: 'Validated', fileType: 'CSV', status: 'VALIDATED' }),
        ];
        const sorted = logic.sortRecords(records, [{ key: 'customer' }, { key: 'status', descending: true }]);
        assert.deepEqual(sorted.map((r) => r.fileName), ['a', 'd', 'c', 'b']);

        const filtered = filterLogic.applyFilters(records, { ...filterLogic.emptyFilters(), customer: 'acme', fileType: 'CSV' }, 'upload');
        assert.deepEqual(logic.sortRecords(filtered, [{ key: 'fileName', descending: true }]).map((r) => r.fileName), ['d', 'a']);
    });
});

describe('Go on the PO Upload tab: result tab', () => {
    test('Failed (exceptions only) goes to Exceptions, everything else to Processed POs', () => {
        assert.equal(filterLogic.resultTab(filterLogic.emptyFilters()), 'processed');
        assert.equal(filterLogic.resultTab({ status: 'FAILED' }), 'exceptions');
        assert.equal(filterLogic.resultTab({ status: 'NEEDS_REVIEW' }), 'processed');
        assert.equal(filterLogic.resultTab({ status: 'CREATED' }), 'processed');
        assert.equal(filterLogic.resultTab(null), 'processed');
    });
});

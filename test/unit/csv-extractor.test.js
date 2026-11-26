import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractCsv } from '../../srv/lib/extraction/csv-extractor.js';
import { ExtractionError } from '../../srv/lib/errors.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const csv = (s) => Buffer.from(s, 'utf8');
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';

describe('CSV extraction', () => {
    test('parses the sample template into the common PO structure', () => {
        const po = extractCsv(fixture('sample-po.csv'));
        assert.deepEqual(po.header, { customerPoNumber: 'PO-2027-0001', poDate: '2027-01-15', requestedDeliveryDate: '2027-02-01' });
        assert.equal(po.items.length, 3);
        assert.deepEqual(po.items[2], { lineNumber: 30, customerMaterial: 'ACME-WASH-10', description: 'Washer M10', quantity: 2.5, uom: 'KG', unitPrice: 12 });
        assert.deepEqual(po.extraction, { method: 'CSV_TEMPLATE_V1', confidence: 1 });
    });

    test('strips invisible characters from text values', () => {
        const po = extractCsv(csv(`${HEADER}\nPO-1\u200B,2027-01-15,,10,UP-FAN-AFO-001\u200B,\u200B,2,EA\u00AD,`));
        assert.equal(po.header.customerPoNumber, 'PO-1');
        assert.deepEqual([po.items[0].customerMaterial, po.items[0].description, po.items[0].uom], ['UP-FAN-AFO-001', null, 'EA']);
    });

    test('supports semicolon delimiter, DD.MM.YYYY dates, quoted values and empty price', () => {
        const po = extractCsv(fixture('sample-po-semicolon.csv'));
        assert.equal(po.header.poDate, '2027-01-15');
        assert.equal(po.items[0].description, 'Hex bolt; zinc');
        assert.equal(po.items[0].unitPrice, null);
    });

    test('accepts UTF-8 BOM, case-insensitive / reordered / extra columns, and sorts lines', () => {
        const po = extractCsv(csv('\uFEFFuom,QUANTITY,line,customermaterial,description,customerpo,podate,deliverydate,unitprice,Comment\n' +
            'EA,1,20,B,,P1,2027-01-01,,,x\nEA,2,10,A,,P1,2027-01-01,2027-01-09,,y\n'));
        assert.deepEqual(po.items.map((i) => i.lineNumber), [10, 20]);
        assert.equal(po.header.requestedDeliveryDate, '2027-01-09');
    });

    test('skips blank lines', () => {
        const po = extractCsv(csv(`${HEADER}\n\nP1,2027-01-01,,1,A,,1,EA,\n,,,,,,,,\n`));
        assert.equal(po.items.length, 1);
    });

    test('rejects missing required columns', () => {
        assert.throws(() => extractCsv(fixture('invalid-missing-columns.csv')), (e) =>
            e instanceof ExtractionError && e.code === 'INVALID_TEMPLATE' && /'UoM' is missing/.test(e.message));
    });

    test('rejects invalid quantities with row numbers', () => {
        assert.throws(() => extractCsv(fixture('invalid-quantities.csv')), (e) => {
            assert.equal(e.code, 'INVALID_DATA');
            assert.equal(e.details.length, 3);
            assert.deepEqual(e.details.map((d) => d.rowNumber), [2, 3, 4]);
            assert.ok(e.details.every((d) => d.field === 'Quantity'));
            return true;
        });
    });

    test('rejects more than 3 decimals, invalid dates, duplicate lines and mixed PO numbers', () => {
        assert.throws(() => extractCsv(csv(`${HEADER}\n` +
            'P1,2027-02-30,,1,A,,1.2345,EA,\n' +
            'P1,2027-01-01,01/02/2027,1,A,,1,EA,\n' +
            'P2,2027-01-01,,2,A,,1,EA,\n')), (e) => {
            const msgs = e.details.map((d) => d.message).join('|');
            assert.match(msgs, /PODate '2027-02-30' is not a valid date/);
            assert.match(msgs, /Quantity '1.2345'/);
            assert.match(msgs, /DeliveryDate '01\/02\/2027'/);
            assert.match(msgs, /Line 1 appears more than once/);
            assert.match(msgs, /CustomerPO 'P2' differs/);
            return true;
        });
    });

    test('rejects missing required values', () => {
        assert.throws(() => extractCsv(csv(`${HEADER}\n,,,,,,,,5\n`)), (e) => {
            const fields = e.details.map((d) => d.field);
            for (const f of ['CustomerPO', 'PODate', 'Line', 'CustomerMaterial', 'Quantity', 'UoM']) assert.ok(fields.includes(f), f);
            return true;
        });
    });

    test('rejects header-only, empty, malformed and non-UTF-8 files', () => {
        assert.throws(() => extractCsv(csv(`${HEADER}\n`)), { code: 'NO_ITEMS' });
        assert.throws(() => extractCsv(csv('')), { code: 'NO_ITEMS' });
        assert.throws(() => extractCsv(csv(`${HEADER}\nP1,2027-01-01,,1,A,,1,EA,,extra\n`)), { code: 'INVALID_CSV' });
        assert.throws(() => extractCsv(Buffer.from([0x43, 0x75, 0xff, 0xfe, 0x0a])), { code: 'INVALID_ENCODING' });
    });
});

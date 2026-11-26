import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { extractXlsx } from '../../srv/lib/extraction/xlsx-extractor.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const HEADER = ['CustomerPO', 'PODate', 'DeliveryDate', 'Line', 'CustomerMaterial', 'Description', 'Quantity', 'UoM', 'UnitPrice'];

async function workbook(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PO');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('XLSX extraction', () => {
    test('parses the sample workbook (date cells, rich text, formulas)', async () => {
        const po = await extractXlsx(fixture('sample-po.xlsx'));
        assert.deepEqual(po.header, { customerPoNumber: 'PO-2027-0101', poDate: '2027-03-01', requestedDeliveryDate: '2027-03-20' });
        assert.equal(po.items.length, 3);
        assert.equal(po.items[2].description, 'Washer M10');
        assert.equal(po.items[2].quantity, 2.5);
        assert.equal(po.extraction.method, 'XLSX_TEMPLATE_V1');
    });

    test('accepts dates and numbers stored as text', async () => {
        const po = await extractXlsx(await workbook([HEADER, ['P1', '2027-01-05', '06.01.2027', '10', 'A', null, '3.5', 'EA', '1.20']]));
        assert.equal(po.header.requestedDeliveryDate, '2027-01-06');
        assert.equal(po.items[0].quantity, 3.5);
        assert.equal(po.items[0].unitPrice, 1.2);
    });

    test('rejects missing required columns', async () => {
        await assert.rejects(extractXlsx(fixture('invalid-missing-columns.xlsx')), { code: 'INVALID_TEMPLATE' });
    });

    test('rejects invalid quantities with row numbers', async () => {
        await assert.rejects(extractXlsx(fixture('invalid-quantities.xlsx')), (e) => {
            assert.equal(e.code, 'INVALID_DATA');
            assert.deepEqual(e.details.map((d) => [d.rowNumber, d.field]), [[2, 'Quantity'], [3, 'Quantity']]);
            return true;
        });
    });

    test('rejects empty worksheet and header-only sheet', async () => {
        await assert.rejects(extractXlsx(await workbook([])), { code: 'NO_ITEMS' });
        await assert.rejects(extractXlsx(await workbook([HEADER])), { code: 'NO_ITEMS' });
    });

    test('rejects a corrupt workbook', async () => {
        await assert.rejects(extractXlsx(Buffer.from('PK\u0003\u0004 not really a zip')), { code: 'INVALID_XLSX' });
    });
});

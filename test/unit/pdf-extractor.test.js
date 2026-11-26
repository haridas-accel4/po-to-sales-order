import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPdf } from '../../srv/lib/extraction/pdf-extractor.js';
import { extractPdfTemplate } from '../../srv/lib/extraction/pdf-template-extractor.js';
import { ExtractionError, ExtractionNotConfiguredError } from '../../srv/lib/errors.js';
import { makePdf, templatePages } from '../support/make-pdf.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const HEADER = { 'Customer PO': 'PO-1', 'PO Date': '2027-01-15' };
const ROWS = [
    ['10', 'ACME-BOLT-10', 'Hex bolt M10', '100', 'PCS', '0.25'],
    ['20', 'ACME-NUT-10', 'Hex nut M10', '2.5', 'KG', ''],
];
const pdf = (po) => makePdf(templatePages({ header: HEADER, rows: ROWS, ...po }));

/** Expect an ExtractionError with the given code; returns it. */
async function rejects(promise, code) {
    let error;
    await assert.rejects(promise, (e) => {
        error = e;
        return e instanceof ExtractionError && e.code === code;
    });
    return error;
}

describe('PDF template extraction', () => {
    test('parses the sample template into the common PO structure', async () => {
        const po = await extractPdfTemplate(fixture('sample-po-template.pdf'));
        assert.deepEqual(po.header, { customerPoNumber: 'PO-2027-0201', poDate: '2027-04-01', requestedDeliveryDate: '2027-04-20' });
        assert.deepEqual(po.items, [
            { lineNumber: 10, customerMaterial: 'ACME-BOLT-10', description: 'Hex bolt M10', quantity: 100, uom: 'PCS', unitPrice: 0.25 },
            { lineNumber: 20, customerMaterial: 'ACME-NUT-10', description: 'Hex nut M10', quantity: 100, uom: 'PCS', unitPrice: 0.1 },
            { lineNumber: 30, customerMaterial: 'ACME-WASH-10', description: 'Washer M10', quantity: 2.5, uom: 'KG', unitPrice: 12 },
        ]);
        assert.deepEqual(po.extraction, { method: 'PDF_TEMPLATE_V1', confidence: 1 });
    });

    test('is the default PDF provider', async () => {
        const po = await extractPdf(fixture('sample-po-template.pdf'), { provider: 'template' });
        assert.equal(po.items.length, 3);
        assert.equal((await extractPdf(fixture('sample-po-template.pdf'))).extraction.method, 'PDF_TEMPLATE_V1');
    });

    test('empty optional values, no delivery date, footer lines are not items', async () => {
        const po = await extractPdfTemplate(pdf({ footer: ['Total: 25.00', 'Payment terms: 30 days net', '10 days delivery'] }));
        assert.equal(po.header.requestedDeliveryDate, null);
        assert.equal(po.items.length, 2);
        assert.equal(po.items[1].unitPrice, null);
    });

    test('accepts reordered and extra columns, column names without spaces / other case', async () => {
        const po = await extractPdfTemplate(pdf({
            columns: ['LINE', 'quantity', 'CustomerMaterial', 'Description', 'UOM', 'UnitPrice', 'Total'],
            xs: [50, 85, 140, 260, 400, 440, 500],
            rows: [['10', '4', 'ACME-BOLT-10', 'Hex bolt', 'PCS', '1.50', '6.00']],
        }));
        assert.deepEqual(po.items[0], { lineNumber: 10, customerMaterial: 'ACME-BOLT-10', description: 'Hex bolt', quantity: 4, uom: 'PCS', unitPrice: 1.5 });
    });

    test('table spanning pages (repeated header), wrapped descriptions, label variants on one line', async () => {
        const rows = Array.from({ length: 5 }, (_, i) => [String((i + 1) * 10), `MAT-${i + 1}`, `Item ${i + 1}`, '1', 'EA', '']);
        const pages = templatePages({ header: {}, rows, rowsPerPage: 3 });
        // header fields in one line, other label spellings
        pages[0].push({ x: 50, y: 770, text: 'PO Number: PO-77' }, { x: 300, y: 770, text: 'Order Date: 15.01.2027' });
        // wrapped description below line 20 (page 1) and a repeated page header with the same PO number on page 2
        pages[0].push({ x: 200, y: 800 - 30 - 14 - 18 - 15 - 7, text: 'with extra text' }); // rows are 15pt apart
        pages[1].push({ x: 50, y: 820, text: 'PO Number: PO-77' });
        const po = await extractPdfTemplate(makePdf(pages));
        assert.deepEqual(po.header, { customerPoNumber: 'PO-77', poDate: '2027-01-15', requestedDeliveryDate: null });
        assert.deepEqual(po.items.map((i) => i.lineNumber), [10, 20, 30, 40, 50]);
        assert.equal(po.items[1].description, 'Item 2 with extra text');
        assert.equal(po.items[2].description, 'Item 3');
    });

    test('a whole table row written as one text run is split into cells', async () => {
        const pages = [[
            { x: 50, y: 800, text: 'Customer PO: PO-9    PO Date: 2027-01-15' },
            { x: 50, y: 770, text: 'Line    Customer Material    Description    Quantity    UoM    Unit Price' },
            { x: 50, y: 755, text: '10      ACME-BOLT-10         Hex bolt       5           PCS    0.25' },
        ]];
        const po = await extractPdfTemplate(makePdf(pages));
        assert.equal(po.header.customerPoNumber, 'PO-9');
        assert.deepEqual(po.items[0], { lineNumber: 10, customerMaterial: 'ACME-BOLT-10', description: 'Hex bolt', quantity: 5, uom: 'PCS', unitPrice: 0.25 });
    });

    test('header fields may be table columns instead of labels', async () => {
        const po = await extractPdfTemplate(makePdf(templatePages({
            columns: ['CustomerPO', 'PODate', 'Line', 'CustomerMaterial', 'Description', 'Quantity', 'UoM', 'UnitPrice'],
            xs: [40, 110, 170, 200, 290, 400, 450, 500],
            rows: [['PO-5', '2027-02-01', '10', 'M-1', 'Bolt', '1', 'EA', '']],
        })));
        assert.deepEqual(po.header, { customerPoNumber: 'PO-5', poDate: '2027-02-01', requestedDeliveryDate: null });
    });

    test('rejects a PDF without item table / with an incomplete table header', async () => {
        let e = await rejects(extractPdfTemplate(makePdf([[{ x: 50, y: 800, text: 'Dear customer, thank you.' }]])), 'INVALID_TEMPLATE');
        assert.match(e.message, /No item table found/);

        e = await rejects(extractPdfTemplate(pdf({ columns: ['Line', 'Customer Material', 'Description', 'Qty', 'UoM', 'Unit Price'] })), 'INVALID_TEMPLATE');
        assert.match(e.message, /Required column 'Quantity' is missing/);
        assert.deepEqual(e.details.map((d) => d.field), ['Quantity']);
    });

    test('rejects missing Customer PO / PO Date and conflicting header values', async () => {
        let e = await rejects(extractPdfTemplate(pdf({ header: { 'Delivery Date': '2027-01-20' } })), 'INVALID_TEMPLATE');
        assert.deepEqual(e.details.map((d) => d.field), ['CustomerPO', 'PODate']);
        assert.match(e.message, /Customer PO not found/);

        const pages = templatePages({ header: HEADER, rows: ROWS });
        pages[0].push({ x: 50, y: 500, text: 'Customer PO: PO-2' });
        e = await rejects(extractPdfTemplate(makePdf(pages)), 'INVALID_DATA');
        assert.match(e.message, /different values \('PO-1' and 'PO-2'/);
    });

    test('applies the template value rules with item row numbers', async () => {
        const e = await rejects(extractPdfTemplate(pdf({
            rows: [['10', 'A', '', 'ten', 'EA', ''], ['10', 'B', '', '1,000', 'EA', '1.234']],
        })), 'INVALID_DATA');
        assert.deepEqual(e.details.map((d) => `${d.rowNumber}:${d.field}`), ['1:Quantity', '2:Line', '2:Quantity', '2:UnitPrice']);
    });

    test('rejects PDFs without text, with no items, and invalid files', async () => {
        await rejects(extractPdfTemplate(makePdf([[]])), 'NO_TEXT');
        await rejects(extractPdfTemplate(pdf({ rows: [] })), 'NO_ITEMS');
        await rejects(extractPdfTemplate(fixture('sample-po.pdf')), 'INVALID_PDF');
        await rejects(extractPdfTemplate(Buffer.from('%PDF-1.4\ngarbage')), 'INVALID_PDF');
    });

    test('provider none / not implemented -> not configured', async () => {
        await assert.rejects(extractPdf(fixture('sample-po-template.pdf'), { provider: 'none' }),
            (e) => e instanceof ExtractionNotConfiguredError && /not configured/.test(e.message));
        await assert.rejects(extractPdf(fixture('sample-po-template.pdf'), { provider: 'document-ai' }),
            (e) => e instanceof ExtractionNotConfiguredError && /'document-ai' is not implemented/.test(e.message));
    });
});

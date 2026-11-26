import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

// Always use a fresh in-memory database for tests, never the persistent development db.sqlite
const { GET, POST, PATCH, DELETE } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');

const SRV = '/odata/v4/sales-order';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const b64 = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url)).toString('base64');
const b64text = (s) => Buffer.from(s, 'utf8').toString('base64');
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';

const upload = (body) => POST(`${SRV}/uploadPurchaseOrder`, body);
const order = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=items($orderby=lineNumber),issues,events($orderby=createdAt)`)).data;

/** Expect an HTTP error; returns the OData error object. */
async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error ?? e;
    }
    assert.fail(`expected HTTP ${status}`);
}

describe('uploadPurchaseOrder API', () => {
    test('valid CSV with known customer -> VALIDATED, file preserved, mappings applied', async () => {
        const { data } = await upload({ fileName: 'sample-po.csv', mimeType: 'text/csv', content: b64('sample-po.csv'), customerId: 'ACME' });
        assert.equal(data.status, 'VALIDATED', data.errorMessage);
        assert.equal(data.errorCount, 0);
        assert.match(data.ID, /^[0-9a-f-]{36}$/);

        const o = await order(data.ID);
        assert.equal(o.source, 'UPLOAD');
        assert.equal(o.customerPoNumber, 'PO-2027-0001');
        assert.equal(o.poDate, '2027-01-15');
        assert.equal(o.soldToParty, '0010100001');
        assert.equal(o.extractionMethod, 'CSV_TEMPLATE_V1');
        assert.equal(Number(o.extractionConfidence), 1);
        assert.deepEqual(o.items.map((i) => [i.lineNumber, i.material, i.sapUom, Number(i.quantity)]),
            [[10, 'TG11', 'PC', 100], [20, 'TG12', 'PC', 100], [30, 'TG13', 'KG', 2.5]]);
        assert.equal(Number(o.items[0].customerUnitPrice), 0.25);
        assert.deepEqual(o.events.map((e) => e.status), ['RECEIVED', 'EXTRACTED', 'VALIDATED']);

        // original file is preserved byte-for-byte
        const file = await GET(`${SRV}/InboundFiles(${o.file_ID})/content`, { responseType: 'arraybuffer' });
        assert.equal(Buffer.from(file.data).toString('base64'), b64('sample-po.csv'));
        const meta = (await GET(`${SRV}/InboundFiles(${o.file_ID})?$select=fileName,size,sha256`)).data;
        assert.equal(meta.fileName, 'sample-po.csv');
        assert.equal(meta.sha256.length, 64);
    });

    test('valid XLSX -> VALIDATED', async () => {
        const { data } = await upload({ fileName: 'sample-po.xlsx', mimeType: XLSX_MIME, content: b64('sample-po.xlsx'), customerId: 'ACME' });
        assert.equal(data.status, 'VALIDATED', data.errorMessage);
        const o = await order(data.ID);
        assert.equal(o.extractionMethod, 'XLSX_TEMPLATE_V1');
        assert.equal(o.items.length, 3);
    });

    test('unknown material / UoM -> NEEDS_REVIEW with item-level issues', async () => {
        const { data } = await upload({ fileName: 'po.csv', mimeType: 'text/csv', content: b64('sample-po-unmapped.csv'), customerId: 'ACME' });
        assert.equal(data.status, 'NEEDS_REVIEW');
        const o = await order(data.ID);
        assert.deepEqual(o.issues.map((i) => `${i.code}@${i.lineNumber}`).sort(), ['MATERIAL_UNMAPPED@20', 'UOM_UNMAPPED@20']);
        assert.equal(o.items[1].material, null);
    });

    test('missing / unknown / inactive customer -> NEEDS_REVIEW', async () => {
        for (const [customerId, code] of [[undefined, 'CUSTOMER_MISSING'], ['NOBODY', 'CUSTOMER_UNKNOWN'], ['INACTIVE', 'CUSTOMER_UNKNOWN']]) {
            const csv = `${HEADER}\nPO-CUST-${code}-${customerId},2027-01-15,2027-02-01,10,ACME-BOLT-10,,1,PCS,\n`;
            const { data } = await upload({ fileName: 'po.csv', mimeType: 'text/csv', content: b64text(csv), customerId });
            assert.equal(data.status, 'NEEDS_REVIEW');
            const o = await order(data.ID);
            assert.ok(o.issues.some((i) => i.code === code), `${customerId}: ${JSON.stringify(o.issues)}`);
            assert.equal(o.soldToParty, null);
        }
    });

    test('review flow: correcting the customer revalidates automatically', async () => {
        const csv = `${HEADER}\nPO-REVIEW-1,2027-01-15,2027-02-01,10,ACME-BOLT-10,,1,PCS,\n`;
        const { data } = await upload({ fileName: 'po.csv', mimeType: 'text/csv', content: b64text(csv) });
        assert.equal(data.status, 'NEEDS_REVIEW');

        await PATCH(`${SRV}/InboundOrders(${data.ID})`, { customerId: 'ACME' });
        let o = await order(data.ID);
        assert.equal(o.status, 'VALIDATED');
        assert.equal(o.soldToParty, '0010100001');

        // item correction with an invalid quantity -> back to NEEDS_REVIEW
        await PATCH(`${SRV}/InboundItems(${o.items[0].ID})`, { quantity: 0 });
        o = await order(data.ID);
        assert.equal(o.status, 'NEEDS_REVIEW');
        assert.ok(o.issues.some((i) => i.code === 'INVALID_QUANTITY'));

        // derived fields / status cannot be set by the client
        await PATCH(`${SRV}/InboundItems(${o.items[0].ID})`, { quantity: 5, material: 'HACKED' });
        await PATCH(`${SRV}/InboundOrders(${data.ID})`, { status: 'CREATED', soldToParty: '9999999999' });
        o = await order(data.ID);
        assert.equal(o.items[0].material, 'TG11');
        assert.equal(o.status, 'VALIDATED');
        assert.equal(o.soldToParty, '0010100001');

        // explicit revalidate action
        const r = await POST(`${SRV}/InboundOrders(${data.ID})/revalidate`, {});
        assert.equal(r.data.status, 'VALIDATED');
    });

    test('duplicate customer PO + sold-to party -> FAILED, original stays valid', async () => {
        const first = (await upload({ fileName: 'a.csv', mimeType: 'text/csv', content: b64('sample-po-semicolon.csv'), customerId: 'ACME' })).data;
        assert.equal(first.status, 'VALIDATED', first.errorMessage);
        const dup = (await upload({ fileName: 'b.csv', mimeType: 'text/csv', content: b64('sample-po-semicolon.csv'), customerId: 'ACME' })).data;
        assert.equal(dup.status, 'FAILED');
        assert.match(dup.errorMessage, /PO-2027-0002.*already exists as inbound order/);
        assert.equal((await order(first.ID)).status, 'VALIDATED');

        // same PO number for a different sold-to party is not a duplicate
        const other = (await upload({ fileName: 'c.csv', mimeType: 'text/csv', content: b64('sample-po-semicolon.csv'), customerId: 'GLOBEX' })).data;
        assert.notEqual(other.status, 'FAILED');
    });

    test('duplicate of an existing sales order -> FAILED', async () => {
        await INSERT.into('po2so.SalesOrders').entries({ customerPoNumber: 'PO-SO-EXISTS', soldToParty: '0010100001', salesOrderNumber: '4711' });
        const csv = `${HEADER}\nPO-SO-EXISTS,2027-01-15,,10,ACME-BOLT-10,,1,PCS,\n`;
        const { data } = await upload({ fileName: 'po.csv', mimeType: 'text/csv', content: b64text(csv), customerId: 'ACME' });
        assert.equal(data.status, 'FAILED');
        assert.match(data.errorMessage, /sales order 4711/);
    });

    test('invalid template content -> stored, FAILED with clear errors', async () => {
        const { data } = await upload({ fileName: 'bad.csv', mimeType: 'text/csv', content: b64('invalid-quantities.csv'), customerId: 'ACME' });
        assert.equal(data.status, 'FAILED');
        assert.equal(data.errorCount, 3);
        assert.match(data.errorMessage, /Row 2: Quantity 'abc' is not a valid number/);
        const o = await order(data.ID);
        assert.equal(o.items.length, 0);
        assert.ok(o.file_ID, 'original file is kept');
        assert.deepEqual(o.events.map((e) => e.status), ['RECEIVED', 'FAILED']);

        const x = (await upload({ fileName: 'bad.xlsx', mimeType: XLSX_MIME, content: b64('invalid-missing-columns.xlsx') })).data;
        assert.equal(x.status, 'FAILED');
        assert.match(x.errorMessage, /Required column 'DeliveryDate' is missing/);

        // never extracted -> revalidate not possible, reprocess is
        await expectError(POST(`${SRV}/InboundOrders(${x.ID})/revalidate`, {}), 409);
        const re = await POST(`${SRV}/InboundOrders(${x.ID})/reprocess`, {});
        assert.equal(re.data.status, 'FAILED');
    });

    test('PDF -> stored, FAILED with actionable "not configured" message', async () => {
        const { data } = await upload({ fileName: 'po.pdf', mimeType: 'application/pdf', content: b64('sample-po.pdf'), customerId: 'ACME' });
        assert.equal(data.status, 'FAILED');
        assert.match(data.errorMessage, /PDF extraction is not configured/);
        const o = await order(data.ID);
        assert.equal(o.issues[0].code, 'EXTRACTION_NOT_CONFIGURED');
        assert.ok(o.file_ID);
    });

    test('rejects unsupported / invalid files with HTTP 400 and stores nothing', async () => {
        const before = (await GET(`${SRV}/InboundOrders/$count`)).data;
        const cases = [
            [{ fileName: 'po.docx', mimeType: 'application/octet-stream', content: b64text('x') }, 'UNSUPPORTED_FILE_TYPE'],
            [{ fileName: 'po.pdf', mimeType: 'text/csv', content: b64('sample-po.pdf') }, 'MIME_TYPE_MISMATCH'],
            [{ fileName: 'po.pdf', mimeType: 'application/pdf', content: b64text('not a pdf') }, 'CONTENT_MISMATCH'],
            [{ fileName: 'po.csv', mimeType: 'text/csv', content: '###' }, 'INVALID_BASE64'],
            [{ fileName: 'po.csv', mimeType: 'text/csv', content: Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString('base64') }, 'FILE_TOO_LARGE'],
        ];
        for (const [body, code] of cases) {
            const err = await expectError(upload(body), 400);
            assert.equal(err.code, code, JSON.stringify(err));
        }
        assert.equal((await GET(`${SRV}/InboundOrders/$count`)).data, before);
    });

    test('rejects missing mandatory parameters', async () => {
        await expectError(upload({ fileName: 'po.csv', mimeType: 'text/csv' }), 400);
    });

    test('inbound orders cannot be created directly', async () => {
        await expectError(POST(`${SRV}/InboundOrders`, { fileName: 'x.csv', status: 'VALIDATED' }), 405);
    });

    test('orders with status CREATED are locked', async () => {
        const csv = `${HEADER}\nPO-LOCKED,2027-01-15,,10,ACME-BOLT-10,,1,PCS,\n`;
        const { data } = await upload({ fileName: 'po.csv', mimeType: 'text/csv', content: b64text(csv), customerId: 'ACME' });
        await UPDATE('po2so.InboundOrders', data.ID).with({ status: 'CREATED', salesOrderNumber: '1234' });
        const o = await order(data.ID);
        await expectError(PATCH(`${SRV}/InboundOrders(${data.ID})`, { customerId: 'GLOBEX' }), 409);
        await expectError(PATCH(`${SRV}/InboundItems(${o.items[0].ID})`, { quantity: 9 }), 409);
        await expectError(DELETE(`${SRV}/InboundOrders(${data.ID})`), 409);
        await expectError(POST(`${SRV}/InboundOrders(${data.ID})/reprocess`, {}), 409);
    });

    test('existing Sales Order entities still work', async () => {
        const { data } = await POST(`${SRV}/SalesOrders`, { customerPoNumber: 'MANUAL-1', items: [{ itemNumber: 10, material: 'TG11', quantity: 1 }] });
        const so = (await GET(`${SRV}/SalesOrders(${data.ID})?$expand=items`)).data;
        assert.equal(so.items.length, 1);
        assert.ok(Array.isArray((await GET(`${SRV}/Customers`)).data.value));
    });
});

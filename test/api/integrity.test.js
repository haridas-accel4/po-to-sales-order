import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

const { GET, POST, PATCH, DELETE } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
// These tests cover intake, review and validation: keep orders open instead of posting them to SAP
// (posting is covered in test/api/sales-order-posting.test.js).
before(() => { cds.env.po2so.autoPost = false; });

const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const JSON_HDR = { 'content-type': 'application/json' };

async function upload(po, customerId = 'ACME') {
    const csv = `${HEADER}\n${po},2027-01-15,2027-02-01,10,ACME-BOLT-10,Bolt,100,PCS,0.25\n${po},2027-01-15,2027-02-01,20,ACME-NUT-10,Nut,5,PCS,\n`;
    return (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: `${po}.csv`, mimeType: 'text/csv', content: b64(csv), customerId })).data;
}
const load = async (ID) =>
    (await GET(`${SRV}/InboundOrders(${ID})?$expand=items($orderby=lineNumber),issues,events,file($select=ID,fileName,sha256,size)`)).data;

/** Expect an HTTP error status; returns the OData error. */
async function expectStatus(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error;
    }
    assert.fail(`expected HTTP ${status}`);
}

const batch = (requests) => POST(`${SRV}/$batch`, { requests }, { headers: JSON_HDR });
const batchStatuses = (res) => res.data.responses.map((r) => r.status);

describe('Data integrity and audit protection', () => {
    let A; let B; // two VALIDATED orders
    before(async () => {
        A = await load((await upload('INT-A')).ID);
        B = await load((await upload('INT-B')).ID);
        assert.equal(A.status, 'VALIDATED');
        assert.equal(B.status, 'VALIDATED');
    });

    describe('1. InboundEvents are append-only', () => {
        test('events cannot be created, modified or deleted directly', async () => {
            const event = A.events[0];
            await expectStatus(PATCH(`${SRV}/InboundEvents(${event.ID})`, { message: 'tampered' }), 405);
            await expectStatus(DELETE(`${SRV}/InboundEvents(${event.ID})`), 405);
            await expectStatus(POST(`${SRV}/InboundEvents`, { parent_ID: A.ID, status: 'VALIDATED', message: 'fake' }), 405);
            const after = await load(A.ID);
            assert.equal(after.events.length, A.events.length);
            assert.equal(after.events.find((e) => e.ID === event.ID).message, event.message);
        });

        test('events cannot be replaced or deleted through a deep update of the order', async () => {
            const err = await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`, { events: [] }), 400);
            assert.match(err.message, /events/);
            await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`,
                { events: [{ ID: A.events[0].ID, message: 'tampered' }] }), 400);
            const after = await load(A.ID);
            assert.deepEqual(after.events.map((e) => e.message).sort(), A.events.map((e) => e.message).sort());
        });

        test('validation issues cannot be removed through a deep update', async () => {
            const { ID } = await upload('INT-ISSUES', null); // no customer -> NEEDS_REVIEW with issues
            const before = await load(ID);
            assert.ok(before.issues.length > 0);
            await expectStatus(PATCH(`${SRV}/InboundOrders(${ID})`, { issues: [] }), 400);
            assert.equal((await load(ID)).issues.length, before.issues.length);
        });

        test('orders cannot be deleted (would cascade to file and audit log)', async () => {
            const err = await expectStatus(DELETE(`${SRV}/InboundOrders(${B.ID})`), 405);
            assert.match(err.message, /cannot be deleted/);
            const after = await load(B.ID);
            assert.equal(after.events.length, B.events.length);
            assert.equal(after.file.sha256, B.file.sha256);
        });

        test('protection also applies inside $batch', async () => {
            const res = await batch([
                { id: '1', method: 'PATCH', url: `InboundOrders(${A.ID})`, headers: JSON_HDR, body: { events: [] } },
                { id: '2', method: 'DELETE', url: `InboundEvents(${A.events[0].ID})`, headers: JSON_HDR },
                { id: '3', method: 'DELETE', url: `InboundOrders(${A.ID})`, headers: JSON_HDR },
            ]);
            assert.deepEqual(batchStatuses(res), [400, 405, 405]);
            assert.equal((await load(A.ID)).events.length, A.events.length);
        });
    });

    describe('2. The original file reference is protected', () => {
        test('file_ID cannot be changed', async () => {
            const err = await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`, { file_ID: B.file_ID }), 400);
            assert.match(err.message, /file_ID/);
            const after = await load(A.ID);
            assert.equal(after.file_ID, A.file_ID);
            assert.equal(after.file.sha256, A.file.sha256);
        });

        test('the stored file cannot be replaced through a deep update', async () => {
            await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`,
                { file: { ID: A.file_ID, fileName: 'evil.csv', content: b64('x') } }), 400);
            await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`, { file: null }), 400);
            const after = await load(A.ID);
            assert.deepEqual(after.file, A.file);
        });

        test('InboundFiles cannot be modified or deleted directly', async () => {
            await expectStatus(PATCH(`${SRV}/InboundFiles(${A.file_ID})`, { fileName: 'evil.csv' }), 405);
            await expectStatus(DELETE(`${SRV}/InboundFiles(${A.file_ID})`), 405);
            assert.equal((await load(A.ID)).file.fileName, 'INT-A.csv');
        });
    });

    describe('3. Items cannot be moved between orders', () => {
        test('parent_ID / parent cannot be changed', async () => {
            const item = A.items[0];
            let err = await expectStatus(PATCH(`${SRV}/InboundItems(${item.ID})`, { parent_ID: B.ID }), 400);
            assert.match(err.message, /cannot be moved/);
            err = await expectStatus(PATCH(`${SRV}/InboundItems(${item.ID})`, { parent: { ID: B.ID } }), 400);
            assert.match(err.message, /cannot be moved/);
            // also when combined with a legitimate field: the whole request is rejected
            await expectStatus(PATCH(`${SRV}/InboundItems(${item.ID})`, { quantity: 7, parent_ID: B.ID }), 400);

            assert.equal((await load(A.ID)).items.length, A.items.length);
            assert.equal((await load(B.ID)).items.length, B.items.length);
            const stored = (await GET(`${SRV}/InboundItems(${item.ID})`)).data;
            assert.equal(stored.parent_ID, A.ID);
            assert.equal(Number(stored.quantity), Number(item.quantity));
        });

        test('items cannot be re-assigned through a deep update of the order', async () => {
            await expectStatus(PATCH(`${SRV}/InboundOrders(${B.ID})`,
                { items: [...B.items.map((i) => ({ ID: i.ID })), { ID: A.items[0].ID, parent_ID: B.ID }] }), 400);
            assert.equal((await load(A.ID)).items.length, A.items.length);
            assert.equal((await load(B.ID)).items.length, B.items.length);
        });

        test('rejected inside $batch as well', async () => {
            const res = await batch([
                { id: '1', method: 'PATCH', url: `InboundItems(${A.items[1].ID})`, headers: JSON_HDR, body: { parent_ID: B.ID } },
            ]);
            assert.deepEqual(batchStatuses(res), [400]);
            assert.equal((await GET(`${SRV}/InboundItems(${A.items[1].ID})`)).data.parent_ID, A.ID);
        });
    });

    describe('4. Strict calendar dates', () => {
        test('impossible dates are rejected and nothing is stored', async () => {
            for (const [field, value] of [['poDate', '2027-02-30'], ['poDate', '2027-02-29'], ['requestedDeliveryDate', '2027-04-31'], ['requestedDeliveryDate', '2027-00-10']]) {
                const err = await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`, { [field]: value }), 400);
                assert.match(JSON.stringify(err), /not a valid (calendar )?date|Invalid|invalid/i, `${field}=${value}: ${JSON.stringify(err)}`);
            }
            const after = await load(A.ID);
            assert.equal(after.poDate, '2027-01-15');
            assert.equal(after.requestedDeliveryDate, '2027-02-01');
            assert.equal(after.status, 'VALIDATED');
        });

        test('error targets the field and both invalid dates are reported', async () => {
            const err = await expectStatus(PATCH(`${SRV}/InboundOrders(${A.ID})`, { poDate: '2027-02-30', requestedDeliveryDate: '2027-06-31' }), 400);
            const targets = (err.details ?? [err]).map((d) => d.target).sort();
            assert.deepEqual(targets, ['poDate', 'requestedDeliveryDate']);
        });

        test('invalid date in a $batch rolls back the whole atomic correction', async () => {
            const res = await batch([
                { id: '1', atomicityGroup: 'g', method: 'PATCH', url: `InboundOrders(${A.ID})`, headers: JSON_HDR, body: { customerPoNumber: 'SHOULD-NOT-SAVE' } },
                { id: '2', atomicityGroup: 'g', method: 'PATCH', url: `InboundOrders(${A.ID})`, headers: JSON_HDR, body: { requestedDeliveryDate: '2027-02-30' } },
            ]);
            assert.ok(batchStatuses(res).some((s) => s === 400));
            assert.equal((await load(A.ID)).customerPoNumber, 'INT-A');
        });

        test('valid dates (incl. leap day) and clearing the delivery date still work', async () => {
            await PATCH(`${SRV}/InboundOrders(${A.ID})`, { poDate: '2028-02-29', requestedDeliveryDate: '2028-03-15' });
            let after = await load(A.ID);
            assert.equal(after.poDate, '2028-02-29');
            assert.equal(after.status, 'VALIDATED');

            await PATCH(`${SRV}/InboundOrders(${A.ID})`, { requestedDeliveryDate: null });
            after = await load(A.ID);
            assert.equal(after.requestedDeliveryDate, null);
            assert.equal(after.status, 'VALIDATED');
            assert.ok(after.issues.some((i) => i.code === 'NO_DELIVERY_DATE' && i.severity === 'WARNING'));
        });
    });

    describe('5. Legitimate reviewer corrections keep working', () => {
        test('header and item corrections are saved and automatically revalidated', async () => {
            const { ID } = await upload('INT-REVIEW', null);
            let order = await load(ID);
            assert.equal(order.status, 'NEEDS_REVIEW');

            await PATCH(`${SRV}/InboundOrders(${ID})`, { customerId: 'ACME', customerPoNumber: 'INT-REVIEW-2', poDate: '2027-01-16' });
            await PATCH(`${SRV}/InboundItems(${order.items[1].ID})`, { quantity: 12, customerUom: 'EA', description: 'Hex nut' });
            order = await load(ID);
            assert.equal(order.status, 'VALIDATED', JSON.stringify(order.issues));
            assert.equal(order.customerPoNumber, 'INT-REVIEW-2');
            assert.deepEqual([Number(order.items[1].quantity), order.items[1].sapUom], [12, 'EA']);
            assert.equal(order.file_ID, order.file.ID);

            // a correction that breaks a rule is saved but flagged, as before
            await PATCH(`${SRV}/InboundItems(${order.items[0].ID})`, { customerMaterial: 'NOT-MAPPED' });
            assert.equal((await load(ID)).status, 'NEEDS_REVIEW');
        });

        test('items can still be added to and removed from their own order', async () => {
            const { ID } = await upload('INT-ITEMS');
            const created = (await POST(`${SRV}/InboundOrders(${ID})/items`,
                { lineNumber: 30, customerMaterial: 'ACME-WASH-10', quantity: 1, customerUom: 'KG' })).data;
            assert.equal(created.parent_ID, ID);
            let order = await load(ID);
            assert.equal(order.items.length, 3);
            assert.equal(order.status, 'VALIDATED', JSON.stringify(order.issues));

            await DELETE(`${SRV}/InboundItems(${created.ID})`);
            order = await load(ID);
            assert.equal(order.items.length, 2);
            assert.ok(order.events.length > 3, 'every correction is logged');
        });

        test('revalidate action and the UI-style atomic $batch still work', async () => {
            const res = await batch([
                { id: 'h', atomicityGroup: 'review', method: 'PATCH', url: `InboundOrders(${B.ID})`, headers: JSON_HDR, body: { requestedDeliveryDate: '2027-03-01' } },
                { id: 'i', atomicityGroup: 'review', method: 'PATCH', url: `InboundItems(${B.items[0].ID})`, headers: JSON_HDR, body: { quantity: 150 } },
            ]);
            assert.deepEqual(batchStatuses(res), [200, 200]);
            assert.equal((await POST(`${SRV}/InboundOrders(${B.ID})/revalidate`, {})).data.status, 'VALIDATED');
            const after = await load(B.ID);
            assert.equal(after.requestedDeliveryDate, '2027-03-01');
            assert.equal(Number(after.items[0].quantity), 150);
        });
    });
});

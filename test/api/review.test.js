import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { loadUi5Module, reviewLogicUrl } from '../support/load-ui5-module.js';

// Exercises the backend exactly the way the SAPUI5 review dialog does:
// GET order -> reviewLogic.buildChanges/buildBatch -> JSON $batch -> GET -> revalidate.
const { GET, POST } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
const logic = loadUi5Module(reviewLogicUrl);

const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const upload = async (csv, customerId) =>
    (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'po.csv', mimeType: 'text/csv', content: b64(csv), customerId })).data;
const load = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=items($orderby=lineNumber),issues($orderby=lineNumber)`)).data;

/** Apply edits to a draft and save via the same JSON $batch the UI sends. */
async function saveLikeUi(order, edit) {
    const original = logic.toDraft(order);
    const draft = JSON.parse(JSON.stringify(original));
    edit(draft);
    assert.equal(logic.validateDraft(draft).count, 0, 'client-side checks pass');
    const changes = logic.buildChanges(original, draft);
    const res = await POST(`${SRV}/$batch`, logic.buildBatch(order.ID, changes), { headers: { 'content-type': 'application/json' } });
    return logic.batchErrors(res.data);
}

describe('Review and correction workflow (UI request sequence)', () => {
    test('NEEDS_REVIEW -> partial correction -> still NEEDS_REVIEW -> full correction -> VALIDATED', async () => {
        const csv = `${HEADER}\nPO-REV-1,2027-01-15,2027-02-01,10,ACME-BOLT-10,Bolt,100,PCS,0.25\nPO-REV-1,2027-01-15,2027-02-01,20,ACME-NUT-X,Nut,5,DRUM,0.10\n`;
        const { ID, status } = await upload(csv); // no customer
        assert.equal(status, 'NEEDS_REVIEW');
        let order = await load(ID);
        // material mapping is only checked once a customer is known
        assert.deepEqual(order.issues.map((i) => i.code).sort(), ['CUSTOMER_MISSING', 'UOM_UNMAPPED']);

        // 1) set the customer only -> material issue for line 20 now appears
        assert.deepEqual(await saveLikeUi(order, (d) => { d.header.customerId = 'ACME'; }), []);
        order = await load(ID);
        assert.equal(order.status, 'NEEDS_REVIEW', JSON.stringify(order.issues));
        assert.equal(order.soldToParty, '0010100001');
        assert.deepEqual(order.issues.map((i) => `${i.code}@${i.lineNumber ?? ''}`).sort(),
            ['MATERIAL_UNMAPPED@20', 'UOM_UNMAPPED@20']);

        // 1b) an invalid quantity (format OK, rule violated) is flagged by the backend
        assert.deepEqual(await saveLikeUi(order, (d) => { d.items[1].quantity = '0'; }), []);
        order = await load(ID);
        assert.ok(order.issues.some((i) => i.code === 'INVALID_QUANTITY' && i.lineNumber === 20));

        // 2) correct material, quantity and UoM of line 20 in one save
        assert.deepEqual(await saveLikeUi(order, (d) => {
            Object.assign(d.items[1], { customerMaterial: 'ACME-NUT-10', quantity: '50', customerUom: 'pcs' });
        }), []);
        order = await load(ID);
        assert.equal(order.status, 'VALIDATED', JSON.stringify(order.issues));
        assert.deepEqual(order.issues, []);
        assert.deepEqual(order.items.map((i) => [i.material, i.sapUom, Number(i.quantity)]), [['TG11', 'PC', 100], ['TG12', 'PC', 50]]);

        // 3) explicit revalidate keeps VALIDATED
        assert.equal((await POST(`${SRV}/InboundOrders(${ID})/revalidate`, {})).data.status, 'VALIDATED');

        // event log keeps the whole history (events of one request share createdAt, so compare as a set)
        const events = (await GET(`${SRV}/InboundEvents?$filter=parent_ID eq ${ID}`)).data.value.map((e) => e.status);
        for (const s of ['RECEIVED', 'EXTRACTED', 'NEEDS_REVIEW', 'VALIDATED']) assert.ok(events.includes(s), s);
        assert.ok(events.length >= 7, `expected the full history, got ${events.length} events`);
    });

    test('a correction that breaks a rule goes back to NEEDS_REVIEW (backend validation is not bypassed)', async () => {
        const csv = `${HEADER}\nPO-REV-2,2027-01-15,2027-02-01,10,ACME-BOLT-10,Bolt,1,PCS,\n`;
        const { ID, status } = await upload(csv, 'ACME');
        assert.equal(status, 'VALIDATED');
        // delivery date before PO date -> backend rule
        assert.deepEqual(await saveLikeUi(await load(ID), (d) => { d.header.requestedDeliveryDate = '2027-01-01'; }), []);
        const order = await load(ID);
        assert.equal(order.status, 'NEEDS_REVIEW');
        assert.equal(order.issues[0].code, 'INVALID_DELIVERY_DATE');
    });

    test('save is atomic: one invalid request rolls back the whole correction', async () => {
        const csv = `${HEADER}\nPO-REV-3,2027-01-15,,10,ACME-BOLT-10,Bolt,1,PCS,\n`;
        const { ID } = await upload(csv, 'ACME');
        const order = await load(ID);
        const batch = {
            requests: [
                { id: 'h', atomicityGroup: 'review', method: 'PATCH', url: `InboundOrders(${ID})`, headers: { 'content-type': 'application/json' }, body: { customerPoNumber: 'CHANGED' } },
                { id: 'i', atomicityGroup: 'review', method: 'PATCH', url: `InboundItems(${order.items[0].ID})`, headers: { 'content-type': 'application/json' }, body: { quantity: 'abc' } },
            ],
        };
        const res = await POST(`${SRV}/$batch`, batch, { headers: { 'content-type': 'application/json' } });
        assert.ok(logic.batchErrors(res.data).length > 0);
        assert.equal((await load(ID)).customerPoNumber, 'PO-REV-3');
    });

    test('status, SAP material and SAP UoM cannot be set through the save request', async () => {
        const csv = `${HEADER}\nPO-REV-4,2027-01-15,,10,UNKNOWN,Thing,1,PCS,\n`;
        const { ID } = await upload(csv, 'ACME');
        const order = await load(ID);
        const batch = {
            requests: [
                { id: 'h', atomicityGroup: 'review', method: 'PATCH', url: `InboundOrders(${ID})`, headers: { 'content-type': 'application/json' }, body: { status: 'VALIDATED', soldToParty: 'X' } },
                { id: 'i', atomicityGroup: 'review', method: 'PATCH', url: `InboundItems(${order.items[0].ID})`, headers: { 'content-type': 'application/json' }, body: { material: 'TG11', sapUom: 'PC' } },
            ],
        };
        await POST(`${SRV}/$batch`, batch, { headers: { 'content-type': 'application/json' } });
        const after = await load(ID);
        assert.equal(after.status, 'NEEDS_REVIEW');
        assert.equal(after.soldToParty, '0010100001');
        assert.equal(after.items[0].material, null);
        assert.equal(after.items[0].sapUom, 'PC'); // from the UoM mapping, not from the request
    });

    test('never-extracted orders are read-only in the UI and cannot be revalidated', async () => {
        const { ID, status } = await upload('CustomerPO,PODate\nX,2027-01-01\n', 'ACME');
        assert.equal(status, 'FAILED');
        assert.equal(logic.reviewState(await load(ID)).editable, false);
        await assert.rejects(POST(`${SRV}/InboundOrders(${ID})/revalidate`, {}), (e) => e.response?.status === 409 || e.status === 409);
    });
});

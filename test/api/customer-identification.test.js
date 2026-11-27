import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { makePdf, templatePages } from '../support/make-pdf.js';
import { loadUi5Module } from '../support/load-ui5-module.js';

// Customer identification for POs that arrive without a customer: identifiers maintained on the
// customer, searched in the attachment and then in the e-mail.
const { GET, POST, PATCH } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
const logic = loadUi5Module(new URL('../../app/sales-order/webapp/model/mappingLogic.js', import.meta.url));

const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const csv = (po) => Buffer.from(`${HEADER}\n${po},2027-05-01,2027-05-20,10,ACME-BOLT-10,Hex bolt,10,PCS,0.25\n`);
/** PDF PO that carries our supplier number at ACME in its header, like an SAP PO's 'Supplier ID'. */
const sapPo = (po, footer = []) => makePdf(templatePages({
    header: { 'Customer PO': po, 'PO Date': '2026-03-06', 'Supplier ID': '0010411010' },
    rows: [['10', 'ACME-BOLT-10', 'Hex bolt', '10', 'PCS', '13.00']],
    footer,
}));

async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error;
    }
    assert.fail(`expected HTTP ${status}`);
}

const order = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=events($orderby=createdAt)`)).data;
const setIdentifiers = (customerId, identifiers) => PATCH(`${SRV}/Customers('${customerId}')`, { identifiers });

let pipeline;

describe('Customer identification', () => {
    before(async () => {
        cds.env.po2so.autoPost = false;
        pipeline = await import('../../srv/lib/pipeline.js');
    });

    test('maintenance: identifiers saved one per line, like the UI sends them', async () => {
        const original = (await GET(`${SRV}/Customers('ACME')`)).data;
        const draft = { ...logic.draftFromRow('customers', original), identifiers: '0010411010; DE 154 512 324\n\nde154512324' };
        assert.deepEqual(logic.validateDraft('customers', draft), {});
        await PATCH(`${SRV}/${logic.keyPredicate('customers', original)}`, logic.buildPayload('customers', draft, original));
        assert.equal((await GET(`${SRV}/Customers('ACME')`)).data.identifiers, '0010411010\nDE 154 512 324');
    });

    test('maintenance: rejects too short identifiers and identifiers of another customer', async () => {
        let e = await expectError(setIdentifiers('GLOBEX', 'GX'), 400);
        assert.match(e.message, /too short/);
        e = await expectError(setIdentifiers('GLOBEX', 'Globex Corporation\nDE154512324'), 409);
        assert.match(e.message, /'DE154512324' is already used by customer 'ACME'/);
        e = await expectError(POST(`${SRV}/Customers`, { customerId: 'NEW', customerName: 'New', soldToParty: '0010100001', identifiers: '0010-4110-10' }), 409);
        assert.match(e.message, /already used by customer 'ACME'/);
        await setIdentifiers('GLOBEX', 'Globex Corporation\nglobex.example');
    });

    test('upload without customer: PDF PO identified by our supplier number on it', async () => {
        const r = (await POST(`${SRV}/uploadPurchaseOrder`, {
            fileName: 'sap-po.pdf', mimeType: 'application/pdf', content: sapPo('4500000500').toString('base64'),
        })).data;
        const o = await order(r.ID);
        assert.equal(o.customerId, 'ACME');
        assert.equal(o.soldToParty, '0010100001');
        assert.equal(o.status, 'VALIDATED', o.errorMessage);
        assert.ok(o.events.some((ev) => ev.message === "Customer ACME identified from the attachment ('0010411010')."));
    });

    test('an explicitly given customer is never overridden', async () => {
        const r = (await POST(`${SRV}/uploadPurchaseOrder`, {
            fileName: 'sap-po.pdf', mimeType: 'application/pdf', content: sapPo('4500000501').toString('base64'), customerId: 'GLOBEX',
        })).data;
        const o = await order(r.ID);
        assert.equal(o.customerId, 'GLOBEX');
        assert.ok(!o.events.some((ev) => /identified/.test(ev.message)));
    });

    test('e-mail: attachment names no customer -> identified from the sender / body', async () => {
        const r = await cds.tx(() => pipeline.ingestDocument({
            source: 'EMAIL', fileName: 'po.csv', mimeType: 'text/csv', buffer: csv('PO-ID-1'),
            emailText: 'Jane <jane@globex.example>\nPO PO-ID-1\nPlease deliver asap.',
        }));
        const o = await order(r.ID);
        assert.equal(o.customerId, 'GLOBEX');
        assert.ok(o.events.some((ev) => ev.message === "Customer GLOBEX identified from the e-mail ('globex.example')."));
    });

    test('several customers or none -> NEEDS_REVIEW with the reason in the processing log', async () => {
        let r = await cds.tx(() => pipeline.ingestDocument({
            source: 'EMAIL', fileName: 'po.pdf', mimeType: 'application/pdf', buffer: sapPo('4500000502'),
            emailText: 'Forwarded on behalf of Globex Corporation',
        }));
        // attachment: ACME only -> ACME, the e-mail body is not consulted
        assert.equal((await order(r.ID)).customerId, 'ACME');

        r = await cds.tx(() => pipeline.ingestDocument({ source: 'EMAIL', fileName: 'po.csv', mimeType: 'text/csv', buffer: csv('PO-ID-3'), emailText: 'Hello' }));
        let o = await order(r.ID);
        assert.equal(o.customerId, null);
        assert.equal(o.status, 'NEEDS_REVIEW');
        assert.ok(o.events.some((ev) => /no customer identifier found in the attachment or the e-mail/.test(ev.message)));

        r = await cds.tx(() => pipeline.ingestDocument({ source: 'EMAIL', fileName: 'po.pdf', mimeType: 'application/pdf',
            buffer: sapPo('4500000503', ['Invoice to: Globex Corporation']), emailText: '' }));
        o = await order(r.ID);
        assert.equal(o.customerId, null);
        assert.ok(o.events.some((ev) => /matches several customers: ACME \('0010411010'\), GLOBEX \('Globex Corporation'\)/.test(ev.message)));
    });
});

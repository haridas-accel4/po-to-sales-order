import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { loadUi5Module } from '../support/load-ui5-module.js';

// Exercises the backend with exactly the requests the SAPUI5 mapping maintenance sends
// (URLs and payloads built by webapp/model/mappingLogic.js).
const { GET, POST, PATCH, DELETE } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
const logic = loadUi5Module(new URL('../../app/sales-order/webapp/model/mappingLogic.js', import.meta.url));

const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url)).toString('base64');

async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error;
    }
    assert.fail(`expected HTTP ${status}`);
}

/** Save like the UI: POST for new rows, PATCH (changed fields only) for existing ones. */
async function saveLikeUi(type, draft, original = null) {
    assert.deepEqual(logic.validateDraft(type, draft), {}, 'client-side checks pass');
    const body = logic.buildPayload(type, draft, original);
    return original
        ? PATCH(`${SRV}/${logic.keyPredicate(type, original)}`, body)
        : POST(`${SRV}/${logic.TYPES[type].entitySet}`, body);
}
const upload = async (po, rows, customerId = 'ACME') =>
    (await POST(`${SRV}/uploadPurchaseOrder`, {
        fileName: `${po}.csv`, mimeType: 'text/csv', customerId,
        content: b64(`${HEADER}\n${rows.map((r) => [po, '2027-01-15', '2027-02-01', ...r].join(',')).join('\n')}\n`),
    })).data;
const load = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=items($orderby=lineNumber),issues,events`)).data;
const codes = (o) => o.issues.map((i) => i.code).sort();

describe('Mapping maintenance (UI request sequence)', () => {
    describe('add and edit each mapping type', () => {
        test('customers', async () => {
            const draft = { ...logic.newDraft('customers'), customerId: 'UMBRELLA', customerName: ' Umbrella Corp ', soldToParty: '0010100010', salesOrganization: '1010' };
            const created = (await saveLikeUi('customers', draft)).data;
            assert.deepEqual([created.customerId, created.customerName, created.active], ['UMBRELLA', 'Umbrella Corp', true]);

            const edited = (await saveLikeUi('customers', { ...logic.draftFromRow('customers', created), customerName: 'Umbrella Corporation', division: '00' }, created)).data;
            assert.deepEqual([edited.customerName, edited.division], ['Umbrella Corporation', '00']);
            const deactivated = (await PATCH(`${SRV}/${logic.keyPredicate('customers', created)}`, { active: false })).data;
            assert.equal(deactivated.active, false);
            await PATCH(`${SRV}/${logic.keyPredicate('customers', created)}`, { active: true });
        });

        test('material mappings (incl. special characters in the key)', async () => {
            const draft = { soldToParty: '0010100001', customerMaterial: "BOLT/10 O'X", material: 'TG11', description: 'Odd key' };
            const created = (await saveLikeUi('materials', draft)).data;
            assert.equal(created.customerMaterial, "BOLT/10 O'X");
            const edited = (await saveLikeUi('materials', { ...draft, material: 'TG12', description: '' }, created)).data;
            assert.deepEqual([edited.material, edited.description], ['TG12', null]);
            const inactive = (await PATCH(`${SRV}/${logic.keyPredicate('materials', created)}`, { active: false })).data;
            assert.equal(inactive.active, false);
            assert.equal((await GET(`${SRV}/${logic.keyPredicate('materials', created)}`)).data.material, 'TG12');
        });

        test('UoM mappings', async () => {
            const created = (await saveLikeUi('uoms', { externalUom: 'PAIL', sapUnit: 'PL' })).data;
            const edited = (await saveLikeUi('uoms', { externalUom: 'PAIL', sapUnit: 'EA' }, created)).data;
            assert.equal(edited.sapUnit, 'EA');
        });
    });

    describe('duplicates are rejected, never silently overwritten', () => {
        test('adding an existing key -> 409 with the field as target; existing row unchanged', async () => {
            for (const [type, draft, field] of [
                ['customers', { customerId: 'ACME', customerName: 'Other', soldToParty: '0010100001' }, 'customerId'],
                ['materials', { soldToParty: '0010100001', customerMaterial: 'acme-bolt-10', material: 'XX' }, 'customerMaterial'],
                ['uoms', { externalUom: 'Pcs', sapUnit: 'XX' }, 'externalUom'],
            ]) {
                const err = await expectError(saveLikeUi(type, { ...logic.newDraft(type), ...draft }), 409);
                assert.deepEqual(Object.keys(logic.errorTargets(err)), [field], type);
            }
            assert.equal((await GET(`${SRV}/Customers('ACME')`)).data.customerName, 'ACME Industries Ltd.');
            assert.equal((await GET(`${SRV}/UomMappings('PCS')`)).data.sapUnit, 'PC');
        });
    });

    describe('customer integrity', () => {
        test('deleting a customer referenced by inbound orders -> 409', async () => {
            await upload('PO-DEL-1', [[10, 'ACME-BOLT-10', '', 1, 'PCS', '']]);
            const err = await expectError(DELETE(`${SRV}/Customers('ACME')`), 409);
            assert.match(err.message, /referenced by \d+ inbound order/);
        });

        test('deleting the only customer behind material mappings -> 409; shared sold-to party -> allowed', async () => {
            await POST(`${SRV}/Customers`, { customerId: 'HOOLI', customerName: 'Hooli', soldToParty: '0010100020' });
            await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100020', customerMaterial: 'H-1', material: 'TG11' });
            const err = await expectError(DELETE(`${SRV}/Customers('HOOLI')`), 409);
            assert.match(err.message, /only customer with sold-to party 0010100020.*1 material mapping/);

            // a second customer ID for the same sold-to party may be deleted
            await POST(`${SRV}/Customers`, { customerId: 'HOOLI-EU', customerName: 'Hooli EU', soldToParty: '0010100020' });
            assert.equal((await DELETE(`${SRV}/Customers('HOOLI-EU')`)).status, 204);
            assert.equal((await GET(`${SRV}/MaterialMappings?$filter=soldToParty eq '0010100020'`)).data.value.length, 1);
        });

        test('changing a sold-to party that would orphan material mappings -> 409', async () => {
            const err = await expectError(PATCH(`${SRV}/Customers('HOOLI')`, { soldToParty: '0010100099' }), 409);
            assert.equal(err.target, 'soldToParty');
            assert.match(err.message, /cannot change from 0010100020 to 0010100099: 1 material mapping/);
            assert.equal((await GET(`${SRV}/Customers('HOOLI')`)).data.soldToParty, '0010100020');

            // allowed when no mappings would be orphaned
            await POST(`${SRV}/Customers`, { customerId: 'PIEDPIPER', customerName: 'Pied Piper', soldToParty: '0010100030' });
            assert.equal((await PATCH(`${SRV}/Customers('PIEDPIPER')`, { soldToParty: '0010100031' })).data.soldToParty, '0010100031');
            // allowed when another customer still carries the old sold-to party
            await POST(`${SRV}/Customers`, { customerId: 'HOOLI-US', customerName: 'Hooli US', soldToParty: '0010100020' });
            assert.equal((await PATCH(`${SRV}/Customers('HOOLI-US')`, { soldToParty: '0010100021' })).status, 200);
        });
    });

    describe('revalidateOpenOrders()', () => {
        test('multiple affected open orders pick up a new mapping; closed and unextractable orders are untouched', async () => {
            const a = await upload('PO-BULK-A', [[10, 'BULK-PART', 'New part', 5, 'PCS', '']]);
            const b = await upload('PO-BULK-B', [[10, 'BULK-PART', 'New part', 7, 'PCS', ''], [20, 'ACME-NUT-10', '', 1, 'PCS', '']]);
            const c = await upload('PO-BULK-C', [[10, 'BULK-PART', '', 1, 'BUCKET', '']]);  // also unmapped UoM
            const done = await upload('PO-BULK-DONE', [[10, 'BULK-PART', '', 1, 'PCS', '']]);
            const broken = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'broken.csv', mimeType: 'text/csv', content: b64('CustomerPO\nX\n'), customerId: 'ACME' })).data;
            for (const o of [a, b, c, done]) assert.equal(o.status, 'NEEDS_REVIEW');
            assert.equal(broken.status, 'FAILED');

            // reviewer correction on B before the mapping exists; CREATED order must stay as it is
            const bItems = (await load(b.ID)).items;
            await PATCH(`${SRV}/InboundItems(${bItems[0].ID})`, { quantity: 9, description: 'Reviewed' });
            await UPDATE('po2so.InboundOrders', done.ID).with({ status: 'CREATED', salesOrderNumber: '9001' });
            const doneEventsBefore = (await load(done.ID)).events.length;
            const aEventsBefore = (await load(a.ID)).events.length;

            await saveLikeUi('materials', { soldToParty: '0010100001', customerMaterial: 'BULK-PART', material: 'TG14', description: '' });
            const { data: result } = await POST(`${SRV}/revalidateOpenOrders`, {});

            const byPo = Object.fromEntries(result.results.map((r) => [r.customerPoNumber, r]));
            assert.equal(byPo['PO-BULK-A'].status, 'VALIDATED');
            assert.equal(byPo['PO-BULK-B'].status, 'VALIDATED');
            assert.equal(byPo['PO-BULK-C'].status, 'NEEDS_REVIEW');
            assert.equal(byPo['PO-BULK-C'].errorCount, 1);
            assert.equal(byPo['PO-BULK-A'].previousStatus, 'NEEDS_REVIEW');
            assert.ok(!byPo['PO-BULK-DONE'], 'CREATED orders are not revalidated');
            assert.ok(!result.results.some((r) => r.ID === broken.ID), 'never-extracted orders are skipped');
            assert.ok(result.skipped >= 1);
            assert.equal(result.errors, 0);
            assert.equal(result.checked, result.results.length);
            assert.equal(result.validated + result.needsReview + result.failed, result.checked);
            assert.equal(result.changed, result.results.filter((r) => r.status !== r.previousStatus).length);

            // data: mapping applied, reviewer correction kept, original file not reprocessed
            const bAfter = await load(b.ID);
            assert.deepEqual([bAfter.items[0].material, Number(bAfter.items[0].quantity), bAfter.items[0].description], ['TG14', 9, 'Reviewed']);
            assert.deepEqual(codes(await load(c.ID)), ['UOM_UNMAPPED']);

            // audit: one new status event per revalidated order, none for the CREATED order
            const aAfter = await load(a.ID);
            assert.equal(aAfter.events.length, aEventsBefore + 1);
            assert.ok(aAfter.events.some((e) => e.status === 'VALIDATED'));
            assert.equal((await load(done.ID)).events.length, doneEventsBefore);
            assert.equal((await load(done.ID)).status, 'CREATED');
        });

        test('a technical failure on one order is reported and logged; other orders are still processed', async () => {
            await upload('PO-FAIL-OK', [[10, 'FAIL-PART', '', 1, 'PCS', '']]);
            const bad = await upload('PO-FAIL-BAD', [[10, 'FAIL-PART', '', 1, 'PCS', '']]);
            await saveLikeUi('materials', { soldToParty: '0010100001', customerMaterial: 'FAIL-PART', material: 'TG11', description: '' });

            let armed = true;
            cds.db.before('DELETE', 'po2so.InboundIssues', (req) => {
                if (armed && JSON.stringify(req.query).includes(bad.ID)) throw new Error('Simulated database failure');
            });
            const { data: result } = await POST(`${SRV}/revalidateOpenOrders`, {});
            armed = false;

            const byPo = Object.fromEntries(result.results.map((r) => [r.customerPoNumber, r]));
            assert.equal(result.errors, 1);
            assert.match(byPo['PO-FAIL-BAD'].error, /Revalidation failed: Simulated database failure/);
            assert.equal(byPo['PO-FAIL-BAD'].status, 'NEEDS_REVIEW');
            assert.equal(byPo['PO-FAIL-OK'].status, 'VALIDATED');
            const badOrder = await load(bad.ID);
            assert.ok(badOrder.events.some((e) => /Revalidation failed: Simulated database failure/.test(e.message)), 'failure is in the audit log');

            // a later run without the failure succeeds
            const again = (await POST(`${SRV}/revalidateOpenOrders`, {})).data;
            assert.equal(again.errors, 0);
            assert.equal((await load(bad.ID)).status, 'VALIDATED');
        });
    });

    describe('review dialog: Add Mapping from an issue', () => {
        test('MATERIAL_UNMAPPED and UOM_UNMAPPED -> create mappings -> revalidate -> VALIDATED', async () => {
            const up = await upload('PO-DIALOG-1', [[10, 'DIALOG-PART', 'Widget', 3, 'TUB', '']]);
            let order = await load(up.ID);
            assert.deepEqual(codes(order), ['MATERIAL_UNMAPPED', 'UOM_UNMAPPED']);

            for (const issue of order.issues) {
                const plan = logic.draftFromIssue(issue, order, order.items.find((i) => i.lineNumber === issue.lineNumber));
                assert.ok(plan, issue.code);
                const draft = { ...plan.draft, ...(plan.type === 'materials' ? { material: 'TG15' } : { sapUnit: 'TB' }) };
                await saveLikeUi(plan.type, draft);
                await POST(`${SRV}/InboundOrders(${up.ID})/revalidate`, {});
            }
            order = await load(up.ID);
            assert.equal(order.status, 'VALIDATED', JSON.stringify(order.issues));
            assert.deepEqual([order.items[0].material, order.items[0].sapUom], ['TG15', 'TB']);
        });
    });

    describe('existing behaviour', () => {
        test('CSV/XLSX uploads still map, review corrections still revalidate', async () => {
            const csv = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'sample-po.csv', mimeType: 'text/csv', content: fixture('sample-po.csv'), customerId: 'GLOBEX' })).data;
            assert.equal(csv.status, 'NEEDS_REVIEW'); // ACME materials are not mapped for GLOBEX
            const xlsx = (await POST(`${SRV}/uploadPurchaseOrder`, {
                fileName: 'sample-po.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: fixture('sample-po.xlsx'), customerId: 'ACME',
            })).data;
            assert.equal(xlsx.status, 'VALIDATED', xlsx.errorMessage);

            await PATCH(`${SRV}/InboundOrders(${csv.ID})`, { customerId: 'ACME' });
            const order = await load(csv.ID);
            assert.equal(order.status, 'VALIDATED');
            assert.deepEqual(order.items.map((i) => i.material), ['TG11', 'TG12', 'TG13']);
        });
    });
});

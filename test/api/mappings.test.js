import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

const { GET, POST, PATCH, PUT, DELETE } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
// These tests cover intake, review and validation: keep orders open instead of posting them to SAP
// (posting is covered in test/api/sales-order-posting.test.js).
before(() => { cds.env.po2so.autoPost = false; });

const SRV = '/odata/v4/sales-order';
const JSON_HDR = { 'content-type': 'application/json' };
const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url)).toString('base64');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';

/** Expect an HTTP error; returns the OData error object. */
async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error;
    }
    assert.fail(`expected HTTP ${status}`);
}
/** Targets of all reported errors (single error or details). */
const targets = (err) => (err.details ?? [err]).map((d) => d.target).sort();

describe('Mapping API protections', () => {
    describe('duplicate keys -> 409 Conflict', () => {
        test('duplicate UoM mapping (exact, different case, surrounding blanks)', async () => {
            let err = await expectError(POST(`${SRV}/UomMappings`, { externalUom: 'PCS', sapUnit: 'ST' }), 409);
            assert.equal(err.code, 'MAPPING_CONFLICT');
            assert.equal(err.target, 'externalUom');
            assert.match(err.message, /UoM mapping for External UoM 'PCS' already exists/);

            err = await expectError(POST(`${SRV}/UomMappings`, { externalUom: 'pcs', sapUnit: 'ST' }), 409);
            assert.match(err.message, /'pcs' conflicts with the existing uom mapping 'PCS'.*case-insensitively/);
            await expectError(POST(`${SRV}/UomMappings`, { externalUom: '  PCS ', sapUnit: 'ST' }), 409);

            // existing mapping untouched
            assert.equal((await GET(`${SRV}/UomMappings('PCS')`)).data.sapUnit, 'PC');
            assert.equal((await GET(`${SRV}/UomMappings?$filter=tolower(externalUom) eq 'pcs'`)).data.value.length, 1);
        });

        test('duplicate customer material mapping (per sold-to party)', async () => {
            let err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'ACME-BOLT-10', material: 'OTHER' }), 409);
            assert.equal(err.target, 'customerMaterial');
            assert.match(err.message, /Material mapping for Customer material 'ACME-BOLT-10' already exists \(sold-to party 0010100001\)/);
            err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'acme-bolt-10', material: 'OTHER' }), 409);
            assert.match(err.message, /case-insensitively/);
            assert.equal((await GET(`${SRV}/MaterialMappings(soldToParty='0010100001',customerMaterial='ACME-BOLT-10')`)).data.material, 'TG11');

            // the same customer material for another sold-to party is a different mapping
            const ok = await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100002', customerMaterial: 'ACME-BOLT-10', material: 'TG11' });
            assert.equal(ok.status, 201);
        });

        test('duplicate customer ID', async () => {
            const err = await expectError(POST(`${SRV}/Customers`, { customerId: 'ACME', customerName: 'Copy', soldToParty: '0010100001' }), 409);
            assert.equal(err.target, 'customerId');
            assert.match(err.message, /Customer for Customer ID 'ACME' already exists/);
            assert.equal((await GET(`${SRV}/Customers('ACME')`)).data.customerName, 'ACME Industries Ltd.');
        });

        test('safety net: any unique-key violation is reported as 409, not 500', async () => {
            const { data } = await POST(`${SRV}/SalesOrders`, { customerPoNumber: 'SN-1' });
            const err = await expectError(POST(`${SRV}/SalesOrders`, { ID: data.ID, customerPoNumber: 'SN-2' }), 409);
            assert.equal(err.code, 'ENTITY_ALREADY_EXISTS');
            assert.match(err.message, /already exists/);
        });

        test('duplicates inside one $batch: first wins, second gets 409', async () => {
            const res = await POST(`${SRV}/$batch`, {
                requests: [
                    { id: '1', method: 'POST', url: 'UomMappings', headers: JSON_HDR, body: { externalUom: 'BATCHU', sapUnit: 'PC' } },
                    { id: '2', method: 'POST', url: 'UomMappings', headers: JSON_HDR, body: { externalUom: 'batchu', sapUnit: 'EA' } },
                ],
            }, { headers: JSON_HDR });
            assert.deepEqual(res.data.responses.map((r) => r.status), [201, 409]);
        });
    });

    describe('required fields -> 400 with the field as target', () => {
        test('UoM mapping', async () => {
            let err = await expectError(POST(`${SRV}/UomMappings`, { externalUom: 'BOX2' }), 400);
            assert.equal(err.code, 'MAPPING_REQUIRED_FIELD');
            assert.equal(err.target, 'sapUnit');
            assert.match(err.message, /SAP unit is required/);
            err = await expectError(POST(`${SRV}/UomMappings`, { externalUom: '   ', sapUnit: 'PC' }), 400);
            assert.equal(err.target, 'externalUom');
            await expectError(PATCH(`${SRV}/UomMappings('KG')`, { sapUnit: '' }), 400);
            await expectError(PATCH(`${SRV}/UomMappings('KG')`, { sapUnit: null }), 400);
            assert.equal((await GET(`${SRV}/UomMappings('KG')`)).data.sapUnit, 'KG');
            assert.equal((await GET(`${SRV}/UomMappings?$filter=externalUom eq 'BOX2'`)).data.value.length, 0);
        });

        test('material mapping: all missing fields are reported', async () => {
            let err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'NEW-1' }), 400);
            assert.equal(err.target, 'material');
            err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '', customerMaterial: ' ', material: '' }), 400);
            assert.deepEqual(targets(err), ['customerMaterial', 'material', 'soldToParty']);
            await expectError(PATCH(`${SRV}/MaterialMappings(soldToParty='0010100001',customerMaterial='ACME-NUT-10')`, { material: ' ' }), 400);
        });

        test('customer: name and sold-to party are required', async () => {
            const err = await expectError(POST(`${SRV}/Customers`, { customerId: 'NEWC' }), 400);
            assert.deepEqual(targets(err), ['customerName', 'soldToParty']);
            await expectError(PATCH(`${SRV}/Customers('ACME')`, { soldToParty: '' }), 400);
            assert.equal((await GET(`${SRV}/Customers('ACME')`)).data.soldToParty, '0010100001');
        });

        test('PUT on a new key is validated like a create', async () => {
            const err = await expectError(PUT(`${SRV}/UomMappings('PUTNEW')`, { sapUnit: '' }), 400);
            assert.equal(err.target, 'sapUnit');
            await expectError(PUT(`${SRV}/MaterialMappings(soldToParty='9999999999',customerMaterial='PUT-1')`, { material: 'X' }), 400);
        });
    });

    describe('material mappings need a valid sold-to party', () => {
        test('unknown sold-to party', async () => {
            const err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '9999999999', customerMaterial: 'A', material: 'B' }), 400);
            assert.equal(err.code, 'UNKNOWN_SOLD_TO');
            assert.equal(err.target, 'soldToParty');
            assert.match(err.message, /'9999999999' does not belong to any maintained customer/);
        });

        test('sold-to party of an inactive customer only', async () => {
            const err = await expectError(POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100009', customerMaterial: 'A', material: 'B' }), 400);
            assert.match(err.message, /belongs only to inactive customers \(INACTIVE\)/);
        });
    });

    describe('customers referenced by inbound orders cannot be deleted', () => {
        test('delete referenced customer -> 409, customer kept; deactivation still possible', async () => {
            const { data } = await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'po.csv', mimeType: 'text/csv', content: fixture('sample-po.csv'), customerId: 'GLOBEX' });
            assert.ok(data.ID);
            const err = await expectError(DELETE(`${SRV}/Customers('GLOBEX')`), 409);
            assert.equal(err.code, 'CUSTOMER_IN_USE');
            assert.match(err.message, /referenced by 1 inbound order\(s\).*active = false/);
            assert.equal((await GET(`${SRV}/Customers('GLOBEX')`)).data.customerId, 'GLOBEX');

            await PATCH(`${SRV}/Customers('GLOBEX')`, { active: false });
            assert.equal((await GET(`${SRV}/Customers('GLOBEX')`)).data.active, false);
            await PATCH(`${SRV}/Customers('GLOBEX')`, { active: true });
        });

        test('unreferenced customer can still be deleted', async () => {
            await POST(`${SRV}/Customers`, { customerId: 'TEMP', customerName: 'Temporary', soldToParty: '0010100077' });
            const res = await DELETE(`${SRV}/Customers('TEMP')`);
            assert.equal(res.status, 204);
        });
    });

    describe('valid mappings can be created and updated and are used by the pipeline', () => {
        test('create (values trimmed), update and deactivate', async () => {
            let res = await POST(`${SRV}/UomMappings`, { externalUom: ' CTN ', sapUnit: 'CAR' });
            assert.equal(res.status, 201);
            assert.deepEqual([res.data.externalUom, res.data.sapUnit], ['CTN', 'CAR']); // key trimmed
            // padded values longer than the field are rejected by CAP's length check (before trimming)
            const tooLong = await expectError(POST(`${SRV}/UomMappings`, { externalUom: 'CTN2', sapUnit: ' CAR ' }), 400);
            assert.equal(tooLong.target, 'sapUnit');
            res = await PATCH(`${SRV}/UomMappings('CTN')`, { sapUnit: 'BOX' });
            assert.equal(res.data.sapUnit, 'BOX');

            res = await POST(`${SRV}/Customers`, { customerId: 'INITECH', customerName: 'Initech', soldToParty: '0010100005', salesOrganization: '1010' });
            assert.equal(res.status, 201);
            res = await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100005', customerMaterial: 'IN-500', material: 'TG12', description: 'Nut' });
            assert.equal(res.status, 201);
            res = await PATCH(`${SRV}/MaterialMappings(soldToParty='0010100005',customerMaterial='IN-500')`, { material: 'TG13', description: 'Washer' });
            assert.equal(res.data.material, 'TG13');
            res = await PATCH(`${SRV}/MaterialMappings(soldToParty='0010100005',customerMaterial='IN-500')`, { active: false });
            assert.equal(res.data.active, false);
            await PATCH(`${SRV}/MaterialMappings(soldToParty='0010100005',customerMaterial='IN-500')`, { active: true });

            // the new mappings are picked up by an upload
            const csv = `${HEADER}\nPO-INITECH-1,2027-01-15,2027-02-01,10,in-500,Washer,4,ctn,\n`;
            const up = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'initech.csv', mimeType: 'text/csv', content: b64(csv), customerId: 'INITECH' })).data;
            assert.equal(up.status, 'VALIDATED', up.errorMessage);
            const items = (await GET(`${SRV}/InboundItems?$filter=parent_ID eq ${up.ID}`)).data.value;
            assert.deepEqual([items[0].material, items[0].sapUom], ['TG13', 'BOX']);
        });

        test('existing CSV and XLSX uploads still map correctly', async () => {
            const csv = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'sample-po.csv', mimeType: 'text/csv', content: fixture('sample-po.csv'), customerId: 'ACME' })).data;
            const xlsx = (await POST(`${SRV}/uploadPurchaseOrder`, {
                fileName: 'sample-po.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: fixture('sample-po.xlsx'), customerId: 'ACME',
            })).data;
            for (const res of [csv, xlsx]) {
                assert.equal(res.status, 'VALIDATED', res.errorMessage);
                const items = (await GET(`${SRV}/InboundItems?$filter=parent_ID eq ${res.ID}&$orderby=lineNumber`)).data.value;
                assert.deepEqual(items.map((i) => [i.material, i.sapUom]), [['TG11', 'PC'], ['TG12', 'PC'], ['TG13', 'KG']]);
            }
        });
    });
});

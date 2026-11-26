import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

// Fresh in-memory database; API_SALES_ORDER_SRV is served by the local mock (srv/external)
const { GET, POST, PATCH } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory', '--with-mocks');

const SRV = '/odata/v4/sales-order';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const b64 = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url)).toString('base64');
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';

/** Template CSV for one PO; lines: [line, customerMaterial, quantity, uom?] */
const csv = (po, lines) => Buffer.from([HEADER, ...lines.map(([line, mat, qty, uom = 'PCS']) =>
    `${po},2027-05-01,2027-05-20,${line},${mat},Item ${line},${qty},${uom},9.99`)].join('\n')).toString('base64');

const upload = (fileName, content, mimeType = 'text/csv') =>
    POST(`${SRV}/uploadPurchaseOrder`, { fileName, mimeType, content, customerId: 'ACME' }).then((r) => r.data);
const resubmit = (ID) => POST(`${SRV}/InboundOrders(${ID})/resubmit`, {}).then((r) => r.data);
const order = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=issues,events($orderby=createdAt)`)).data;

let s4;
let sapDown = false;
const sapOrders = (where) => s4.run(SELECT.from(s4.entities.A_SalesOrder, (o) => { o('*'), o.to_Item((i) => i('*')); }).where(where));

async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error ?? e;
    }
    assert.fail(`expected HTTP ${status}`);
}

describe('Sales order creation in SAP', () => {
    // inside the suite: runs after cds.test has started the server and the mock
    before(async () => {
        s4 = await cds.connect.to('API_SALES_ORDER_SRV');
        // simulate an unreachable tenant the way CAP's remote client reports it (HTTP 502, no SAP response)
        s4.prepend(() => s4.before('*', () => {
            if (sapDown) throw Object.assign(new Error('Error during request to remote service: connect ECONNREFUSED'), { statusCode: 502, reason: { message: 'connect ECONNREFUSED' } });
        }));
    });

    test('valid CSV upload -> CREATED, sales order in SAP with mapped data and no PO price', async () => {
        const result = await upload('sample-po.csv', b64('sample-po.csv'));
        assert.equal(result.status, 'CREATED', result.errorMessage);
        assert.match(result.salesOrderNumber, /^\d+$/);

        const o = await order(result.ID);
        assert.equal(o.salesOrderNumber, result.salesOrderNumber);
        assert.equal(o.errorMessage, null);
        assert.deepEqual(o.events.map((e) => e.status), ['RECEIVED', 'EXTRACTED', 'VALIDATED', 'CREATED']);

        const [so] = await sapOrders({ SalesOrder: result.salesOrderNumber });
        assert.deepEqual(
            [so.SalesOrderType, so.SalesOrganization, so.DistributionChannel, so.OrganizationDivision, so.SoldToParty],
            ['OR', '1010', '10', '00', '0010100001']);
        assert.equal(so.PurchaseOrderByCustomer, 'PO-2027-0001');
        assert.equal(so.CustomerPurchaseOrderDate, '2027-01-15');
        assert.equal(so.RequestedDeliveryDate, '2027-02-01');
        assert.deepEqual(
            so.to_Item.sort((a, b) => a.SalesOrderItem - b.SalesOrderItem)
                .map((i) => [i.SalesOrderItem, i.Material, i.MaterialByCustomer, Number(i.RequestedQuantity), i.RequestedQuantityUnit]),
            [['10', 'TG11', 'ACME-BOLT-10', 100, 'PC'], ['20', 'TG12', 'ACME-NUT-10', 100, 'PC'], ['30', 'TG13', 'ACME-WASH-10', 2.5, 'KG']]);
        // SAP prices the order itself (mock list price 0.24 for TG11, PO said 0.25)
        assert.equal(Number(so.to_Item.find((i) => i.Material === 'TG11').NetAmount), 24);
    });

    test('valid XLSX upload -> CREATED', async () => {
        const result = await upload('sample-po.xlsx', b64('sample-po.xlsx'), XLSX_MIME);
        assert.equal(result.status, 'CREATED', result.errorMessage);
        const [so] = await sapOrders({ SalesOrder: result.salesOrderNumber });
        assert.equal(so.PurchaseOrderByCustomer, 'PO-2027-0101');
        assert.equal(so.to_Item.length, 3);
    });

    test('same PO uploaded twice -> second FAILED as duplicate, only one SAP order', async () => {
        const first = await upload('dup-1.csv', csv('PO-DUP-1', [[10, 'ACME-BOLT-10', 5]]));
        assert.equal(first.status, 'CREATED', first.errorMessage);
        const second = await upload('dup-1-again.csv', csv('PO-DUP-1', [[10, 'ACME-BOLT-10', 5]]));
        assert.equal(second.status, 'FAILED');
        assert.equal(second.salesOrderNumber, null);
        assert.ok((await order(second.ID)).issues.some((i) => i.code === 'DUPLICATE_PO'));
        assert.equal((await sapOrders({ PurchaseOrderByCustomer: 'PO-DUP-1' })).length, 1);
    });

    test('PO that already exists only in SAP -> FAILED naming the SAP order', async () => {
        await s4.run(INSERT.into(s4.entities.A_SalesOrder).entries({
            SalesOrderType: 'OR', SalesOrganization: '1010', DistributionChannel: '10', OrganizationDivision: '00',
            SoldToParty: '0010100001', PurchaseOrderByCustomer: 'PO-IN-SAP',
            to_Item: [{ SalesOrderItem: '10', Material: 'TG11', RequestedQuantity: '1', RequestedQuantityUnit: 'PC' }],
        }));
        const [existing] = await sapOrders({ PurchaseOrderByCustomer: 'PO-IN-SAP' });

        const result = await upload('in-sap.csv', csv('PO-IN-SAP', [[10, 'ACME-BOLT-10', 1]]));
        assert.equal(result.status, 'FAILED');
        assert.match(result.errorMessage, new RegExp(`sales order ${existing.SalesOrder}`));
        assert.equal((await sapOrders({ PurchaseOrderByCustomer: 'PO-IN-SAP' })).length, 1);
    });

    test('SAP rejects the order -> FAILED with SAP message; fix mapping and resubmit -> CREATED', async () => {
        // mapped in the app, but the material does not exist in SAP
        await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'ACME-NEW-1', material: 'TG99' });
        const result = await upload('sap-error.csv', csv('PO-SAP-ERR', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        assert.match(result.errorMessage, /SAP rejected the sales order/);
        assert.match(result.errorMessage, /Material TG99 does not exist/);
        const o = await order(result.ID);
        assert.ok(o.issues.some((i) => i.code === 'SAP_ERROR' && /TG99/.test(i.message)));
        assert.equal(o.events.at(-1).status, 'FAILED');

        await PATCH(`${SRV}/MaterialMappings(soldToParty='0010100001',customerMaterial='ACME-NEW-1')`, { material: 'TG11' });
        const fixed = await resubmit(result.ID);
        assert.equal(fixed.status, 'CREATED', fixed.errorMessage);
        const [so] = await sapOrders({ SalesOrder: fixed.salesOrderNumber });
        assert.equal(so.to_Item[0].Material, 'TG11');
        assert.equal((await order(result.ID)).issues.some((i) => i.code === 'SAP_ERROR'), false);
    });

    test('order with errors -> NEEDS_REVIEW and nothing is posted, also not on resubmit', async () => {
        const result = await upload('unmapped.csv', csv('PO-REVIEW-1', [[10, 'UNKNOWN-MAT', 1]]));
        assert.equal(result.status, 'NEEDS_REVIEW');
        const again = await resubmit(result.ID);
        assert.equal(again.status, 'NEEDS_REVIEW');
        assert.equal((await sapOrders({ PurchaseOrderByCustomer: 'PO-REVIEW-1' })).length, 0);
    });

    test('SAP not reachable -> stays VALIDATED with a warning; resubmit later -> CREATED', async () => {
        sapDown = true;
        let result;
        try {
            result = await upload('sap-down.csv', csv('PO-SAP-DOWN', [[10, 'ACME-BOLT-10', 2]]));
        } finally {
            sapDown = false;
        }
        assert.equal(result.status, 'VALIDATED');
        assert.match(result.errorMessage, /not available.*Resubmit/s);
        const o = await order(result.ID);
        assert.ok(o.issues.some((i) => i.code === 'SAP_UNAVAILABLE' && i.severity === 'WARNING'));

        const retried = await resubmit(result.ID);
        assert.equal(retried.status, 'CREATED', retried.errorMessage);
        assert.equal(retried.errorMessage, null);
    });

    test('a created order cannot be resubmitted', async () => {
        const result = await upload('final.csv', csv('PO-FINAL-1', [[10, 'ACME-NUT-10', 4]]));
        assert.equal(result.status, 'CREATED', result.errorMessage);
        await expectError(POST(`${SRV}/InboundOrders(${result.ID})/resubmit`, {}), 409);
        assert.equal((await sapOrders({ PurchaseOrderByCustomer: 'PO-FINAL-1' })).length, 1);
    });
});

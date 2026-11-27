import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toSalesOrderPayload, describeSapError } from '../../srv/lib/sap-sales-order.js';

const customer = { soldToParty: '0010100001', salesOrganization: '1010', distributionChannel: '10', division: '00' };
const order = { customerPoNumber: 'ACME-PO-10234', poDate: '2026-11-20', requestedDeliveryDate: '2026-12-05' };
const items = [
    { lineNumber: 20, customerMaterial: 'AC-NUT-M8', material: 'TG12', quantity: '500.000', sapUom: 'PC', customerUnitPrice: 1.2 },
    { lineNumber: 10, customerMaterial: 'AC-BOLT-M8', material: 'TG11', quantity: 500, sapUom: 'PC', customerUnitPrice: 4.5 },
];

describe('toSalesOrderPayload', () => {
    test('builds the A_SalesOrder deep insert from mapped data (build guide example)', () => {
        assert.deepEqual(toSalesOrderPayload(order, items, customer, { salesOrderType: 'OR' }), {
            SalesOrderType: 'OR',
            SalesOrganization: '1010',
            DistributionChannel: '10',
            OrganizationDivision: '00',
            SoldToParty: '0010100001',
            PurchaseOrderByCustomer: 'ACME-PO-10234',
            CustomerPurchaseOrderDate: '2026-11-20',
            RequestedDeliveryDate: '2026-12-05',
            to_Item: [
                { SalesOrderItem: '10', Material: 'TG11', MaterialByCustomer: 'AC-BOLT-M8', RequestedQuantity: '500', RequestedQuantityUnit: 'PC' },
                { SalesOrderItem: '20', Material: 'TG12', MaterialByCustomer: 'AC-NUT-M8', RequestedQuantity: '500', RequestedQuantityUnit: 'PC' },
            ],
        });
    });

    test('never sends the price; omits a missing delivery date and currency', () => {
        const payload = toSalesOrderPayload({ ...order, requestedDeliveryDate: null }, items, customer, { salesOrderType: 'OR' });
        assert.equal('RequestedDeliveryDate' in payload, false);
        assert.doesNotMatch(JSON.stringify(payload), /Price|Currency|NetAmount/);
    });

    test('sends the PO currency; omits the unit when the PO has none (SAP: material master unit)', () => {
        const payload = toSalesOrderPayload({ ...order, currency: 'USD' }, [{ ...items[1], sapUom: null }], customer, { salesOrderType: 'OR' });
        assert.equal(payload.TransactionCurrency, 'USD');
        assert.deepEqual(payload.to_Item, [{ SalesOrderItem: '10', Material: 'TG11', MaterialByCustomer: 'AC-BOLT-M8', RequestedQuantity: '500' }]);
        assert.doesNotMatch(JSON.stringify(payload), /Price|NetAmount/);
    });
});

describe('describeSapError', () => {
    test('SAP business error (remote 400) -> business, message and error details', () => {
        const e = {
            message: 'Error during request to remote service: Material TG99 does not exist',
            statusCode: 502,
            reason: { response: { status: 400, body: { error: {
                message: { lang: 'en', value: 'Material TG99 does not exist' },
                innererror: { errordetails: [
                    { message: 'Material TG99 does not exist', severity: 'error' },
                    { message: 'Pricing incomplete', severity: 'error' },
                    { message: 'Document saved partially', severity: 'info' },
                ] },
            } } } },
        };
        assert.deepEqual(describeSapError(e), { business: true, httpStatus: 400, messages: ['Material TG99 does not exist', 'Pricing incomplete'] });
    });

    test('unreachable tenant (no response) -> technical', () => {
        const e = { message: 'Error during request to remote service: connect ECONNREFUSED', statusCode: 502, reason: { message: 'x' } };
        const d = describeSapError(e);
        assert.equal(d.business, false);
        assert.deepEqual(d.messages, ['connect ECONNREFUSED']);
    });

    test('authorization / configuration problems are technical, not data errors', () => {
        for (const status of [401, 403, 404, 500, 503]) {
            assert.equal(describeSapError({ message: 'x', reason: { response: { status } } }).business, false, `HTTP ${status}`);
        }
    });

    test('local mock rejection (status 400, several details) -> business', () => {
        const e = { message: 'MULTIPLE_ERRORS', code: 'MULTIPLE_ERRORS', status: 400, details: [{ message: 'A' }, { message: 'B' }] };
        assert.deepEqual(describeSapError(e), { business: true, httpStatus: 400, messages: ['A', 'B'] });
    });
});

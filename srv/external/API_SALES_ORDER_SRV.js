import cds from '@sap/cds';

/**
 * Local mock of the SAP Cloud ERP Sales Order API.
 *
 * Used only while API_SALES_ORDER_SRV has no credentials (`cds watch`, tests).
 * With a destination bound (production / hybrid), CAP calls the real tenant and
 * this file is not used.
 *
 * It imitates what the demo relies on:
 *   - mandatory header fields and at least one item
 *   - a "material master": only the materials below exist; any other material
 *     is rejected the way SAP rejects it, so the SAP-error path can be shown
 *   - sales order numbers assigned by SAP
 *   - pricing done by SAP (the PO price is never sent)
 */

/** Materials that exist in the mock tenant, with their SAP list price per unit. */
const MATERIALS = {
    TG11: { text: 'Hex bolt M10', price: 0.24, unit: 'PC' },
    TG12: { text: 'Hex nut M10', price: 0.09, unit: 'PC' },
    TG13: { text: 'Washer M10', price: 11.5, unit: 'KG' },
};
const CURRENCY = 'EUR';
const FIRST_NUMBER = 1000000;
const REQUIRED_HEADER = ['SalesOrderType', 'SalesOrganization', 'DistributionChannel', 'OrganizationDivision', 'SoldToParty'];

export default class SalesOrderApiMock extends cds.ApplicationService {
    init() {
        const { A_SalesOrder } = this.entities;

        this.before('CREATE', A_SalesOrder, async (req) => {
            const order = req.data;
            const items = order.to_Item ?? [];

            for (const field of REQUIRED_HEADER) {
                if (!order[field]) req.error(400, `Mandatory field ${field} is missing.`, field);
            }
            if (!items.length) req.error(400, 'Sales order has no items.', 'to_Item');
            for (const item of items) {
                const ref = `Item ${item.SalesOrderItem ?? '?'}`;
                if (!item.Material) req.error(400, `${ref}: material is missing.`);
                else if (!MATERIALS[item.Material]) {
                    req.error(400, `${ref}: Material ${item.Material} does not exist or is not defined for sales org. ${order.SalesOrganization}, distr. chan. ${order.DistributionChannel}.`);
                }
                if (!(Number(item.RequestedQuantity) > 0)) req.error(400, `${ref}: requested quantity must be greater than zero.`);
            }
            if (order.TransactionCurrency && !/^[A-Z]{3}$/.test(order.TransactionCurrency)) {
                req.error(400, `Currency ${order.TransactionCurrency} is not defined.`, 'TransactionCurrency');
            }
            if (req.errors) return req.reject();

            const numbers = await SELECT.from(A_SalesOrder).columns('SalesOrder');
            const last = numbers.reduce((max, r) => Math.max(max, Number(r.SalesOrder) || 0), FIRST_NUMBER);
            order.SalesOrder = String(last + 1);
            order.CreationDate = new Date().toISOString().slice(0, 10);
            const currency = order.TransactionCurrency || CURRENCY; // from the request, else the customer's
            order.TransactionCurrency = currency;
            order.OverallSDProcessStatus = 'A';
            order.OverallDeliveryStatus = 'A';

            let total = 0;
            for (const item of items) {
                const net = Math.round(Number(item.RequestedQuantity) * MATERIALS[item.Material].price * 100) / 100;
                total += net;
                Object.assign(item, {
                    SalesOrder: order.SalesOrder,
                    SalesOrderItemText: item.SalesOrderItemText ?? MATERIALS[item.Material].text,
                    RequestedQuantityUnit: item.RequestedQuantityUnit || MATERIALS[item.Material].unit, // material master unit
                    NetAmount: net,
                    TransactionCurrency: currency,
                });
            }
            order.TotalNetAmount = Math.round(total * 100) / 100;
        });

        return super.init();
    }
}

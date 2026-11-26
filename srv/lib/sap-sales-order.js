import cds from '@sap/cds';

/**
 * SAP Cloud ERP Sales Order API (API_SALES_ORDER_SRV, OData V2) access.
 *
 * The only module that knows SAP field names. Locally CAP serves a mock
 * (srv/external/API_SALES_ORDER_SRV.js); in production the destination S4HC_SALES
 * points it at the tenant. Both are called through the same CQL, so this code does
 * not change between the two.
 */

export const SAP_SERVICE = 'API_SALES_ORDER_SRV';

export const connectSalesOrderApi = () => cds.connect.to(SAP_SERVICE);

/**
 * Build the A_SalesOrder deep-insert payload from a VALIDATED inbound order.
 * Sales area comes from the customer mapping, never from the document.
 * The customer's PO price and currency are deliberately not sent: SAP pricing decides.
 *
 * @param {object} order     InboundOrders row (customerPoNumber, poDate, requestedDeliveryDate)
 * @param {object[]} items   InboundItems with mapped material / sapUom
 * @param {object} customer  Customers row (soldToParty, sales area)
 * @param {{salesOrderType:string}} options
 */
export function toSalesOrderPayload(order, items, customer, { salesOrderType }) {
    const payload = {
        SalesOrderType: salesOrderType,
        SalesOrganization: customer.salesOrganization,
        DistributionChannel: customer.distributionChannel,
        OrganizationDivision: customer.division,
        SoldToParty: customer.soldToParty,
        PurchaseOrderByCustomer: order.customerPoNumber,
        CustomerPurchaseOrderDate: order.poDate,
        to_Item: [...items]
            .sort((a, b) => a.lineNumber - b.lineNumber)
            .map((it) => ({
                SalesOrderItem: String(it.lineNumber),
                Material: it.material,
                MaterialByCustomer: it.customerMaterial,
                RequestedQuantity: String(Number(it.quantity)),
                RequestedQuantityUnit: it.sapUom,
            })),
    };
    // header only: a schedule-line date is ignored on create (KBA 3730144)
    if (order.requestedDeliveryDate) payload.RequestedDeliveryDate = order.requestedDeliveryDate;
    return payload;
}

/** Existing sales order for this customer PO number and sold-to party, or null. */
export async function findSalesOrder(s4, { customerPoNumber, soldToParty }) {
    const { A_SalesOrder } = s4.entities;
    const row = await s4.run(SELECT.one.from(A_SalesOrder).columns('SalesOrder')
        .where({ PurchaseOrderByCustomer: customerPoNumber, SoldToParty: soldToParty }));
    return row?.SalesOrder ?? null;
}

/** Create the sales order; returns the SAP sales order number. */
export async function createSalesOrder(s4, payload) {
    const { A_SalesOrder } = s4.entities;
    const created = await s4.run(INSERT.into(A_SalesOrder).entries(payload));
    const number = created?.SalesOrder ?? (Array.isArray(created) ? created[0]?.SalesOrder : null);
    if (number) return number;
    // some response shapes carry no body: read the new order back by its unique PO reference
    const found = await findSalesOrder(s4, { customerPoNumber: payload.PurchaseOrderByCustomer, soldToParty: payload.SoldToParty });
    if (!found) throw new Error('SAP accepted the sales order but returned no sales order number.');
    return found;
}

const REMOTE_PREFIX = /^Error during request to remote service:\s*/;

/**
 * Classify an error from the Sales Order API.
 *  - business: SAP rejected the data (HTTP 400/409/422 ...) -> fix the data, order FAILED
 *  - otherwise technical: SAP not reachable, auth/config problem, timeout -> retry later
 * @returns {{business:boolean, httpStatus:number|null, messages:string[]}}
 */
export function describeSapError(e) {
    const response = e?.reason?.response;
    const httpStatus = response?.status ?? localStatus(e);
    const messages = [];
    const sapError = response?.body?.error;
    if (sapError) {
        messages.push(sapError.message?.value ?? sapError.message);
        for (const d of sapError.innererror?.errordetails ?? []) {
            if (!d.severity || d.severity === 'error') messages.push(d.message);
        }
    } else if (Array.isArray(e?.details) && e.details.length) {
        messages.push(...e.details.map((d) => d.message));
    } else {
        messages.push(e?.message);
    }
    const unique = [...new Set(messages.filter(Boolean).map((m) => String(m).replace(REMOTE_PREFIX, '').trim()))];
    const business = httpStatus >= 400 && httpStatus < 500 && ![401, 403, 404, 408, 429].includes(httpStatus);
    return { business, httpStatus: httpStatus ?? null, messages: unique.length ? unique : ['Unknown error from the Sales Order API.'] };
}

/** HTTP status of an error raised by the in-process mock (cds.error / req.reject). */
function localStatus(e) {
    if (!e || e.reason) return null; // wrapped remote error without an HTTP response (network, DNS, timeout)
    for (const v of [e.status, e.statusCode, e.code]) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 100 && n < 600) return n;
    }
    return null;
}

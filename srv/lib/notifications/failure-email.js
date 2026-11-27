/**
 * Content of the "sales order creation failed" e-mail. Pure function: no I/O.
 * All PO values come from customer documents and are escaped for HTML.
 */

export const FAILURE_TYPES = {
    SAP_REJECTED: {
        title: 'SAP rejected the sales order',
        status: 'FAILED - SAP rejected the sales order',
        action: 'Correct the data (e.g. material, unit or customer mapping) in the PO review and resubmit the order.',
    },
    SAP_DUPLICATE: {
        title: 'Sales order already exists in SAP',
        status: 'FAILED - a sales order for this customer PO already exists in SAP',
        action: 'Check the existing SAP sales order; no further action is needed if it is correct.',
    },
    SAP_UNAVAILABLE: {
        title: 'SAP Sales Order API not available',
        status: 'NOT CREATED - SAP not reachable; the order is still VALIDATED',
        action: 'Check the SAP connection (destination, credentials, availability) and resubmit the order.',
    },
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const orDash = (value) => (value === null || value === undefined || value === '' ? '-' : String(value));

/** "2027-05-01T10:15:03.123Z" -> "2027-05-01 10:15:03 UTC" */
export const formatUtc = (iso) => (iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

/**
 * @param {object} input
 * @param {{failureType:string, messages:string[], httpStatus?:number|null, failedAt:string}} input.failure
 * @param {object} input.order     InboundOrders row
 * @param {object|null} input.customer  Customers row
 * @param {object[]} [input.items] InboundItems rows
 * @param {{sender?:string, subject?:string, receivedAt?:string}|null} [input.email]  Gmail origin
 * @returns {{subject:string, text:string, html:string}}
 */
export function composeFailureEmail({ failure, order, customer, items = [], email = null }) {
    const type = FAILURE_TYPES[failure.failureType] ?? { title: 'Sales order creation failed', status: 'FAILED', action: 'Check the order in the app.' };
    const customerName = customer?.customerName || order.customerId || 'Unknown customer';
    const po = order.customerPoNumber || '(no PO number)';
    const subject = oneLine(`[PO2SO] Sales order creation failed: PO ${po} - ${customerName}`).slice(0, 200);
    const reasons = failure.messages?.length ? failure.messages : ['No error message returned.'];
    const salesArea = customer ? [customer.salesOrganization, customer.distributionChannel, customer.division].map(orDash).join(' / ') : '-';

    const summary = [
        ['Customer name', customerName],
        ['Customer ID', orDash(order.customerId)],
        ['Sold-to party', orDash(order.soldToParty ?? customer?.soldToParty)],
        ['Customer PO number', po],
        ['Sales order status', type.status],
        ['Failure reason', type.title + (failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : '')],
        ['Failed at', formatUtc(failure.failedAt)],
    ];
    const details = [
        ['PO date', orDash(order.poDate)],
        ['Requested delivery date', orDash(order.requestedDeliveryDate)],
        ['Sales area (org / channel / division)', salesArea],
        ['Source', order.source === 'EMAIL' ? 'Gmail' : 'Manual upload'],
        ['File', orDash(order.fileName)],
        ...(email ? [['E-mail from', orDash(email.sender)], ['E-mail subject', orDash(email.subject)], ['E-mail received', formatUtc(email.receivedAt)]] : []),
        ['Inbound order ID', order.ID],
    ];
    const itemRows = [...items].sort((a, b) => a.lineNumber - b.lineNumber).map((it) => [
        orDash(it.lineNumber), orDash(it.customerMaterial), orDash(it.material), orDash(it.description),
        it.quantity === null || it.quantity === undefined ? '-' : String(Number(it.quantity)), orDash(it.sapUom ?? it.customerUom),
    ]);
    const itemHeader = ['Line', 'Customer material', 'SAP material', 'Description', 'Quantity', 'UoM'];

    const pad = (rows) => {
        const width = Math.max(...rows.map(([k]) => k.length)) + 2;
        return rows.map(([k, v]) => `${`${k}:`.padEnd(width)}${oneLine(v)}`);
    };
    const text = [
        'Sales order creation in SAP failed for a customer purchase order.',
        '',
        ...pad(summary),
        '',
        'SAP error message / failure reason:',
        ...reasons.map((m) => `  - ${oneLine(m)}`),
        '',
        'Purchase order details:',
        ...pad(details).map((l) => `  ${l}`),
        '',
        `Items (${itemRows.length}):`,
        ...(itemRows.length ? itemRows.map((r) => `  ${r.map(oneLine).join(' | ')}`) : ['  -']),
        '',
        `Next step: ${type.action}`,
        '',
        'This is an automated message from PO-to-Sales-Order. Each failure is reported once.',
    ].join('\n');

    const th = 'style="text-align:left;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap"';
    const td = 'style="padding:4px 12px 4px 0;vertical-align:top"';
    const kvTable = (rows) => `<table style="border-collapse:collapse">${rows.map(([k, v]) =>
        `<tr><th ${th}>${escapeHtml(k)}</th><td ${td}>${escapeHtml(v)}</td></tr>`).join('')}</table>`;
    const html = [
        '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2d3e">',
        `<h2 style="color:#aa0808;margin:0 0 12px">Sales order creation failed: ${escapeHtml(type.title)}</h2>`,
        kvTable(summary),
        '<h3 style="margin:16px 0 6px">SAP error message / failure reason</h3>',
        `<ul style="margin:0;padding-left:20px">${reasons.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`,
        '<h3 style="margin:16px 0 6px">Purchase order details</h3>',
        kvTable(details),
        `<h3 style="margin:16px 0 6px">Items (${itemRows.length})</h3>`,
        itemRows.length
            ? `<table style="border-collapse:collapse"><tr>${itemHeader.map((h) => `<th ${th}>${h}</th>`).join('')}</tr>` +
              `${itemRows.map((r) => `<tr>${r.map((c) => `<td ${td}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`
            : '<p>-</p>',
        `<p style="margin-top:16px"><b>Next step:</b> ${escapeHtml(type.action)}</p>`,
        '<p style="color:#556b82;font-size:12px">This is an automated message from PO-to-Sales-Order. Each failure is reported once.</p>',
        '</body></html>',
    ].join('\n');

    return { subject, text, html };
}

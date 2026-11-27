import { addressOf } from './config.js';

/**
 * Content of the internal exception e-mail. Pure function: no I/O.
 * All PO values come from customer documents and are escaped for HTML.
 *
 *   SAP_*                                         sales order creation failed (any channel)
 *   EXTRACTION_FAILED / NEEDS_REVIEW / DUPLICATE_PO  an e-mailed PO stopped before SAP
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
    EXTRACTION_FAILED: {
        subject: 'E-mailed PO could not be read',
        intro: 'An e-mailed customer purchase order could not be read. No sales order was created.',
        title: 'The attachment could not be read as a purchase order',
        status: 'FAILED - extraction failed; no sales order created',
        reasonsHeading: 'Extraction errors',
        timeLabel: 'Received at',
        action: 'Open the order under Exceptions and check the file. If it is a purchase order, ask the customer for a readable file '
            + '(CSV, XLSX or a text-based PDF).',
    },
    NEEDS_REVIEW: {
        subject: 'E-mailed PO needs review',
        intro: 'An e-mailed customer purchase order needs review before a sales order can be created.',
        title: 'Missing or unmapped data',
        status: 'NEEDS REVIEW - no sales order created yet',
        reasonsHeading: 'Validation errors',
        timeLabel: 'Received at',
        action: 'Open the order under Exceptions, assign the customer, fix the listed fields or mappings and resubmit it.',
    },
    DUPLICATE_PO: {
        subject: 'E-mailed PO is a duplicate',
        intro: 'An e-mailed customer purchase order was not posted: the same customer PO already exists in the app.',
        title: 'Duplicate customer PO',
        status: 'FAILED - duplicate customer PO; no sales order created',
        reasonsHeading: 'Duplicate check',
        timeLabel: 'Received at',
        action: 'Check the existing order; no further action is needed if it is correct.',
    },
};

const SAP_INTRO = 'Sales order creation in SAP failed for a customer purchase order.';

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const orDash = (value) => (value === null || value === undefined || value === '' ? '-' : String(value));

/** "2027-05-01T10:15:03.123Z" -> "2027-05-01 10:15:03 UTC" */
export const formatUtc = (iso) => (iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

/** [label, value] rows -> "label:   value" lines with aligned values */
export const padRows = (rows) => {
    const width = Math.max(...rows.map(([k]) => k.length)) + 2;
    return rows.map(([k, v]) => `${`${k}:`.padEnd(width)}${oneLine(v)}`);
};

const th = 'style="text-align:left;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap"';
const td = 'style="padding:4px 12px 4px 0;vertical-align:top"';
export const kvTable = (rows) => `<table style="border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><th ${th}>${escapeHtml(k)}</th><td ${td}>${escapeHtml(v)}</td></tr>`).join('')}</table>`;
export const gridTable = (header, rows) => `<table style="border-collapse:collapse"><tr>${header.map((h) => `<th ${th}>${escapeHtml(h)}</th>`).join('')}</tr>` +
    `${rows.map((r) => `<tr>${r.map((c) => `<td ${td}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`;

/**
 * @param {object} input
 * @param {{failureType:string, messages:string[], httpStatus?:number|null, failedAt:string}} input.failure
 * @param {object} input.order     InboundOrders row
 * @param {object|null} input.customer  Customers row
 * @param {object[]} [input.items] InboundItems rows
 * @param {{sender?:string, subject?:string, receivedAt?:string}|null} [input.email]  Gmail origin
 * @param {string|null} [input.customerNotice]  e-mailed PO: what the customer was told
 * @returns {{subject:string, text:string, html:string}}
 */
export function composeFailureEmail({ failure, order, customer, items = [], email = null, customerNotice = null }) {
    const type = FAILURE_TYPES[failure.failureType] ?? { title: 'Sales order creation failed', status: 'FAILED', action: 'Check the order in the app.' };
    const heading = type.subject ?? 'Sales order creation failed';
    const intro = type.intro ?? SAP_INTRO;
    const reasonsHeading = type.reasonsHeading ?? 'SAP error message / failure reason';
    const customerName = customer?.customerName || order.customerId || 'Unknown customer';
    const po = order.customerPoNumber || '(no PO number)';
    // an e-mailed PO without a customer yet: name the sender instead
    const who = customer?.customerName || order.customerId || addressOf(email?.sender) || customerName;
    const subject = oneLine(`[PO2SO] ${heading}: PO ${po} - ${who}`).slice(0, 200);
    const reasons = failure.messages?.length ? failure.messages : ['No error message returned.'];
    const salesArea = customer ? [customer.salesOrganization, customer.distributionChannel, customer.division].map(orDash).join(' / ') : '-';

    const summary = [
        ['Customer name', customerName],
        ['Customer ID', orDash(order.customerId)],
        ['Sold-to party', orDash(order.soldToParty ?? customer?.soldToParty)],
        ['Customer PO number', po],
        ['Sales order status', type.status],
        ['Failure reason', type.title + (failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : '')],
        [type.timeLabel ?? 'Failed at', formatUtc(failure.failedAt)],
        ...(customerNotice ? [['Customer e-mail', customerNotice]] : []),
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

    const text = [
        intro,
        '',
        ...padRows(summary),
        '',
        `${reasonsHeading}:`,
        ...reasons.map((m) => `  - ${oneLine(m)}`),
        '',
        'Purchase order details:',
        ...padRows(details).map((l) => `  ${l}`),
        '',
        `Items (${itemRows.length}):`,
        ...(itemRows.length ? itemRows.map((r) => `  ${r.map(oneLine).join(' | ')}`) : ['  -']),
        '',
        `Next step: ${type.action}`,
        '',
        'This is an automated message from PO-to-Sales-Order. Each failure is reported once.',
    ].join('\n');

    const html = [
        '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2d3e">',
        `<h2 style="color:#aa0808;margin:0 0 12px">${escapeHtml(heading)}: ${escapeHtml(type.title)}</h2>`,
        ...(type.intro ? [`<p>${escapeHtml(intro)}</p>`] : []),
        kvTable(summary),
        `<h3 style="margin:16px 0 6px">${escapeHtml(reasonsHeading)}</h3>`,
        `<ul style="margin:0;padding-left:20px">${reasons.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`,
        '<h3 style="margin:16px 0 6px">Purchase order details</h3>',
        kvTable(details),
        `<h3 style="margin:16px 0 6px">Items (${itemRows.length})</h3>`,
        itemRows.length ? gridTable(itemHeader, itemRows) : '<p>-</p>',
        `<p style="margin-top:16px"><b>Next step:</b> ${escapeHtml(type.action)}</p>`,
        '<p style="color:#556b82;font-size:12px">This is an automated message from PO-to-Sales-Order. Each failure is reported once.</p>',
        '</body></html>',
    ].join('\n');

    return { subject, text, html };
}

import { addressOf } from './config.js';
import { escapeHtml, formatUtc, gridTable, kvTable, oneLine, orDash, padRows } from './failure-email.js';

/**
 * Content of the status e-mails that are not internal exceptions. Pure functions: no I/O.
 *
 *   composeCreatedEmail()       internal: "sales order created" for an e-mailed PO
 *   composeUnderReviewEmail()   customer: "we received your PO and are reviewing it"
 *   composeConfirmationEmail()  customer: "your PO was entered as sales order N"
 *
 * Customer e-mails reply in the thread of the customer's PO e-mail and contain only what the
 * customer sent plus our sales order number: no prices (SAP pricing may differ from the PO),
 * no SAP / validation messages, no internal IDs.
 */

const FOOTER_INTERNAL = 'This is an automated message from PO-to-Sales-Order.';
const BODY_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2d3e';

const qty = (value) => (value === null || value === undefined ? '-' : String(Number(value)));
const sortItems = (items) => [...items].sort((a, b) => a.lineNumber - b.lineNumber);

/** "Re: <original subject>" keeps the reply in the customer's thread; a fallback if there was none. */
export function replySubject(email, fallback) {
    const original = oneLine(email?.subject);
    if (!original) return oneLine(fallback).slice(0, 200);
    return (/^re:/i.test(original) ? original : `Re: ${original}`).slice(0, 200);
}

/**
 * @param {{order:object, customer:object|null, items?:object[], email?:object|null, createdAt:string, customerNotice:string}} input
 */
export function composeCreatedEmail({ order, customer, items = [], email = null, createdAt, customerNotice }) {
    const customerName = customer?.customerName || order.customerId || 'Unknown customer';
    const po = order.customerPoNumber || '(no PO number)';
    const so = order.salesOrderNumber || '-';
    const subject = oneLine(`[PO2SO] Sales order ${so} created: PO ${po} - ${customerName}`).slice(0, 200);

    const summary = [
        ['Customer name', customerName],
        ['Customer ID', orDash(order.customerId)],
        ['Sold-to party', orDash(order.soldToParty ?? customer?.soldToParty)],
        ['Customer PO number', po],
        ['SAP sales order', so],
        ['Sales order status', 'CREATED'],
        ['Created at', formatUtc(createdAt)],
        ['Customer confirmation', customerNotice],
    ];
    const details = [
        ['PO date', orDash(order.poDate)],
        ['Requested delivery date', orDash(order.requestedDeliveryDate)],
        ['File', orDash(order.fileName)],
        ...(email ? [['E-mail from', orDash(email.sender)], ['E-mail subject', orDash(email.subject)], ['E-mail received', formatUtc(email.receivedAt)]] : []),
        ['Inbound order ID', order.ID],
    ];
    const header = ['Line', 'Customer material', 'SAP material', 'Description', 'Quantity', 'UoM'];
    const rows = sortItems(items).map((it) => [orDash(it.lineNumber), orDash(it.customerMaterial), orDash(it.material), orDash(it.description),
        qty(it.quantity), orDash(it.sapUom ?? it.customerUom)]);

    const text = [
        `Sales order ${so} was created in SAP for an e-mailed customer purchase order.`,
        '',
        ...padRows(summary),
        '',
        'Purchase order details:',
        ...padRows(details).map((l) => `  ${l}`),
        '',
        `Items (${rows.length}):`,
        ...(rows.length ? rows.map((r) => `  ${r.map(oneLine).join(' | ')}`) : ['  -']),
        '',
        FOOTER_INTERNAL,
    ].join('\n');
    const html = [
        `<!doctype html><html><body style="${BODY_STYLE}">`,
        `<h2 style="color:#256f3a;margin:0 0 12px">Sales order ${escapeHtml(so)} created</h2>`,
        kvTable(summary),
        '<h3 style="margin:16px 0 6px">Purchase order details</h3>',
        kvTable(details),
        `<h3 style="margin:16px 0 6px">Items (${rows.length})</h3>`,
        rows.length ? gridTable(header, rows) : '<p>-</p>',
        `<p style="color:#556b82;font-size:12px">${FOOTER_INTERNAL}</p>`,
        '</body></html>',
    ].join('\n');
    return { subject, text, html };
}

const signOff = (signature) => ['', 'Kind regards,', signature];
const htmlSignOff = (signature) => `<p>Kind regards,<br>${escapeHtml(signature)}</p>`;
const htmlParagraphs = (lines) => lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n');

/**
 * @param {{order:object, email:object, signature:string}} input
 */
export function composeUnderReviewEmail({ order, email, signature }) {
    const po = order.customerPoNumber;
    const subject = replySubject(email, `Your purchase order${po ? ` ${po}` : ''}`);
    const received = email?.receivedAt ? ` of ${formatUtc(email.receivedAt)}` : '';
    const paragraphs = [
        `Thank you for your purchase order${po ? ` ${po}` : ''}. We have received your e-mail${received} and are reviewing the order.`,
        'You will receive a confirmation with our sales order number as soon as the order has been entered. No action is needed from you at this point.',
    ];
    const text = ['Hello,', '', paragraphs.join('\n\n'), ...signOff(signature)].join('\n');
    const html = [
        `<!doctype html><html><body style="${BODY_STYLE}">`,
        '<p>Hello,</p>',
        htmlParagraphs(paragraphs),
        htmlSignOff(signature),
        '</body></html>',
    ].join('\n');
    return { subject, text, html };
}

/**
 * @param {{order:object, items?:object[], email?:object|null, signature:string}} input
 */
export function composeConfirmationEmail({ order, items = [], email = null, signature }) {
    const po = order.customerPoNumber || '-';
    const so = order.salesOrderNumber || '-';
    const subject = replySubject(email, `Order confirmation: your PO ${po} - our sales order ${so}`);
    const intro = `Thank you for your purchase order ${po}. It has been entered as our sales order ${so}.`;
    const summary = [
        ['Your PO number', po],
        ['Your PO date', orDash(order.poDate)],
        ['Our sales order', so],
        ['Requested delivery date', orDash(order.requestedDeliveryDate)],
    ];
    // the customer's own material numbers and units, not SAP's
    const header = ['Line', 'Your material', 'Description', 'Quantity', 'Unit'];
    const rows = sortItems(items).map((it) => [orDash(it.lineNumber), orDash(it.customerMaterial), orDash(it.description),
        qty(it.quantity), orDash(it.customerUom ?? it.sapUom)]);
    const closing = 'If anything is not as expected, please reply to this e-mail.';

    const text = [
        'Hello,', '', intro, '',
        ...padRows(summary), '',
        `Items (${rows.length}):`,
        ...(rows.length ? rows.map((r) => `  ${r.map(oneLine).join(' | ')}`) : ['  -']),
        '', closing,
        ...signOff(signature),
    ].join('\n');
    const html = [
        `<!doctype html><html><body style="${BODY_STYLE}">`,
        '<p>Hello,</p>',
        `<p>${escapeHtml(intro)}</p>`,
        kvTable(summary),
        `<h3 style="margin:16px 0 6px">Items (${rows.length})</h3>`,
        rows.length ? gridTable(header, rows) : '<p>-</p>',
        `<p>${escapeHtml(closing)}</p>`,
        htmlSignOff(signature),
        '</body></html>',
    ].join('\n');
    return { subject, text, html };
}

/** The bare sender address of an e-mailed PO, or null. */
export const senderAddress = (email) => addressOf(email?.sender);

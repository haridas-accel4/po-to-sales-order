import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { createFakeGmail } from '../support/fake-gmail.js';
import { startFakeSmtp, parseMail } from '../support/fake-smtp.js';

// End-to-end status e-mails for e-mailed POs: fake Gmail in, fake SMTP out. Nothing leaves the machine.
const smtp = await startFakeSmtp({ users: { 'mailer@example.com': 'secret' } });
const UNSET = ['SO_FAILURE_EMAIL_TO', 'SO_FAILURE_EMAIL_ENABLED', 'SMTP_SECURE', 'SO_CREATED_EMAIL_TO', 'SO_CREATED_EMAIL_ENABLED',
    'PO_CUSTOMER_EMAIL_ENABLED', 'PO_CUSTOMER_EMAIL_REPLY_TO', 'PO_CUSTOMER_EMAIL_SIGNATURE'];
const SMTP_ENV = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_REQUIRE_TLS: 'false',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 'secret',
    SO_FAILURE_EMAIL_FROM: 'PO2SO Notifications <mailer@example.com>',
    GMAIL_AUTO_POLL_ENABLED: 'false',
};
const resetEnv = () => {
    for (const k of UNSET) delete process.env[k];
    Object.assign(process.env, SMTP_ENV);
};
resetEnv();

const { GET, POST, PATCH } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory', '--with-mocks');

const SRV = '/odata/v4/sales-order';
const MAILBOX = 'po-inbox@example.com';
const INTERNAL = 'haridas.shinde@accel4.com';
const BUYER = 'buyer@customer.example';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const csv = (po, mat = 'ACME-BOLT-10') => Buffer.from(`${HEADER}\n${po},2027-05-01,2027-05-20,10,${mat},Hex bolt,10,PCS,0.25\n`);
const BROKEN = Buffer.from('Invoice,Amount\nINV-1,100\n'); // a CSV that is not a PO

let notifications;
let intake;
let gmailConfig;
let fake;
let s4;

const mails = () => smtp.messages.map((m) => ({ ...m, ...parseMail(m.raw) }));
const to = (address) => mails().filter((m) => m.to.includes(address));
const rows = (orderId) => SELECT.from('po2so.FailureNotifications').where({ inboundOrder_ID: orderId }).orderBy('createdAt');

/** Deliver one e-mail to the fake inbox, run a sync and wait for all status e-mails. */
async function receive({ subject = 'Purchase Order PO-1', from = `Buyer <${BUYER}>`, attachments, messageId } = {}) {
    const id = fake.addMessage({ subject, from, messageId, text: 'Please find our purchase order attached.', attachments });
    await intake.syncMailbox({ client: fake.client, mailbox: MAILBOX, backfillDays: 1, config: gmailConfig.getGmailConfig() });
    await notifications.whenIdle();
    const orders = (await GET(`${SRV}/InboundOrders?$filter=source eq 'EMAIL' and emailAttachment/message/gmailMessageId eq '${id}'&$orderby=fileName`)).data.value;
    return { id, orders };
}

const resubmit = async (ID) => {
    const result = (await POST(`${SRV}/InboundOrders(${ID})/resubmit`, {})).data;
    await notifications.whenIdle();
    return result;
};
const assignCustomer = async (ID, customerId = 'ACME') => {
    await PATCH(`${SRV}/InboundOrders(${ID})`, { customerId });
    await notifications.whenIdle();
};

describe('Status e-mails for e-mailed POs', () => {
    before(async () => {
        notifications = await import('../../srv/lib/notifications/index.js');
        intake = await import('../../srv/lib/gmail/intake.js');
        gmailConfig = await import('../../srv/lib/gmail/config.js');
        (await import('../../srv/lib/notifications/config.js')).allowSendingInTests(true);
        cds.env.po2so.failureNotification = { retry: { retries: 1, baseDelayMs: 5 } };
        fake = createFakeGmail({ emailAddress: MAILBOX });
        s4 = await cds.connect.to('API_SALES_ORDER_SRV');
        // an unknown SAP material: mapped in the app, rejected by the SAP mock
        await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'ACME-NEW-1', material: 'TG99' });
    });
    after(async () => {
        await notifications?.whenIdle();
        await smtp.close();
    });
    beforeEach(async () => {
        await notifications.whenIdle();
        smtp.reset();
        resetEnv();
    });

    test('PO needs review -> internal exception e-mail + "under review" reply to the sender', async () => {
        const { orders: [order] } = await receive({ subject: 'Purchase Order PO-E-REV', messageId: '<po-e-rev@mail.customer.example>',
            attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-REV') }] });
        assert.equal(order.status, 'NEEDS_REVIEW');
        assert.equal(mails().length, 2);

        const [internal] = to(INTERNAL);
        assert.equal(internal.subject, `[PO2SO] E-mailed PO needs review: PO PO-E-REV - ${BUYER}`);
        for (const expected of ['NEEDS REVIEW - no sales order created yet', 'Validation errors', 'customer', `"Under review" e-mail sent to ${BUYER}`, order.ID]) {
            assert.ok(internal.text.includes(expected), `internal text contains ${expected}`);
        }

        const [customer] = to(BUYER);
        assert.equal(customer.subject, 'Re: Purchase Order PO-E-REV');
        assert.equal(customer.headers['in-reply-to'], '<po-e-rev@mail.customer.example>');
        assert.equal(customer.headers.references, '<po-e-rev@mail.customer.example>');
        assert.equal(customer.headers['auto-submitted'], 'auto-generated');
        assert.match(customer.text, /Thank you for your purchase order PO-E-REV\. We have received your e-mail .* and are reviewing the order\./);
        assert.match(customer.text, /Customer Service$/);
        // nothing internal reaches the customer
        for (const internalOnly of [order.ID, 'CUSTOMER', 'NEEDS', 'TG11', 'PO2SO']) assert.ok(!customer.text.includes(internalOnly), `no ${internalOnly}`);

        const log = await rows(order.ID);
        assert.deepEqual(log.map((r) => `${r.audience}:${r.failureType}:${r.status}`).sort(),
            ['CUSTOMER:UNDER_REVIEW:SENT', 'INTERNAL:NEEDS_REVIEW:SENT']);
    });

    test('review -> resubmit -> created: internal "created" e-mail + order confirmation to the customer, no second "under review"', async () => {
        const { orders: [order] } = await receive({ subject: 'PO PO-E-OK', messageId: '<po-e-ok@mail.customer.example>',
            attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-OK') }] });
        smtp.reset();

        await assignCustomer(order.ID); // revalidation by a reviewer: no new e-mail
        assert.equal(mails().length, 0);
        const result = await resubmit(order.ID);
        assert.equal(result.status, 'CREATED', result.errorMessage);
        const so = result.salesOrderNumber;
        assert.ok(so);

        const [internal] = to(INTERNAL);
        assert.equal(internal.subject, `[PO2SO] Sales order ${so} created: PO PO-E-OK - ACME Industries Ltd.`);
        for (const expected of ['CREATED', so, 'TG11', `Order confirmation sent to ${BUYER}`, BUYER]) {
            assert.ok(internal.text.includes(expected), `internal text contains ${expected}`);
        }

        const customerMails = to(BUYER);
        assert.equal(customerMails.length, 1, 'only the confirmation');
        const [confirmation] = customerMails;
        assert.equal(confirmation.subject, 'Re: PO PO-E-OK');
        assert.equal(confirmation.headers['in-reply-to'], '<po-e-ok@mail.customer.example>');
        assert.ok(confirmation.text.includes(`It has been entered as our sales order ${so}.`));
        assert.ok(confirmation.text.includes('ACME-BOLT-10'), 'customer material');
        assert.ok(confirmation.text.includes('2027-05-20'), 'requested delivery date');
        assert.ok(!confirmation.text.includes('0.25') && !confirmation.html.includes('0.25'), 'no prices');
        assert.ok(!confirmation.text.includes('TG11'), 'no SAP material numbers');

        // a CREATED order cannot be resubmitted, so nothing is sent again
        smtp.reset();
        await assert.rejects(resubmit(order.ID), /409/);
        await notifications.whenIdle();
        assert.equal(mails().length, 0);
    });

    test('SAP rejects the resubmitted order -> internal SAP e-mail only; the customer already has "under review"', async () => {
        const { orders: [order] } = await receive({ subject: 'PO PO-E-REJ',
            attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-REJ', 'ACME-NEW-1') }] });
        assert.equal(to(BUYER).length, 1);
        smtp.reset();

        await assignCustomer(order.ID);
        assert.equal((await resubmit(order.ID)).status, 'FAILED');
        assert.equal(to(BUYER).length, 0, 'no second "under review"');
        const [internal] = to(INTERNAL);
        assert.equal(internal.subject, '[PO2SO] Sales order creation failed: PO PO-E-REJ - ACME Industries Ltd.');
        assert.match(internal.text, /Customer e-mail:\s+"Under review" e-mail already sent to buyer@customer\.example earlier/);
    });

    test('two POs in one e-mail -> one "under review" reply, one internal e-mail per PO', async () => {
        const { orders } = await receive({ subject: 'Purchase orders', attachments: [
            { fileName: 'a.csv', mimeType: 'text/csv', content: csv('PO-E-TWO-A') },
            { fileName: 'b.csv', mimeType: 'text/csv', content: csv('PO-E-TWO-B') },
        ] });
        assert.equal(orders.length, 2);
        assert.equal(to(BUYER).length, 1);
        assert.equal(to(INTERNAL).length, 2);
    });

    test('attachment is not a readable PO -> internal e-mail only; the sender is not contacted', async () => {
        const { orders: [order] } = await receive({ subject: 'SO please pay',
            attachments: [{ fileName: 'invoice.csv', mimeType: 'text/csv', content: BROKEN }] });
        assert.equal(order.status, 'FAILED');
        assert.equal(to(BUYER).length, 0);
        const [internal] = to(INTERNAL);
        assert.match(internal.subject, /^\[PO2SO\] E-mailed PO could not be read: PO \(no PO number\) - buyer@customer\.example$/);
        assert.match(internal.text, /Customer e-mail:\s+Not contacted - the file may not be a purchase order/);
        assert.match(internal.text, /Extraction errors:/);
    });

    test('same PO e-mailed again -> a second review e-mail (no customer yet, so no duplicate check: known limitation)', async () => {
        const first = await receive({ subject: 'PO PO-E-DUP', attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-DUP') }] });
        await assignCustomer(first.orders[0].ID);
        smtp.reset();
        const { orders: [second] } = await receive({ subject: 'PO PO-E-DUP again', attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-DUP') }] });
        // no customer on the e-mailed copy -> no duplicate check yet; this documents the current behaviour
        assert.equal(second.status, 'NEEDS_REVIEW');
        assert.equal(to(INTERNAL).length, 1);
        assert.equal(to(BUYER).length, 1);
    });

    test('customer e-mails switched off -> internal e-mails only, and they say so', async () => {
        process.env.PO_CUSTOMER_EMAIL_ENABLED = 'false';
        const { orders: [order] } = await receive({ subject: 'PO PO-E-OFF', attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-OFF') }] });
        assert.equal(to(BUYER).length, 0);
        assert.match(to(INTERNAL)[0].text, /Not contacted - customer e-mails are switched off/);
        await assignCustomer(order.ID);
        assert.equal((await resubmit(order.ID)).status, 'CREATED');
        assert.equal(to(BUYER).length, 0);
        assert.match(to(INTERNAL).at(-1).text, /Customer confirmation:\s+Not contacted - customer e-mails are switched off/);
    });

    test('PO sent from the polled mailbox itself -> no customer e-mail', async () => {
        await receive({ subject: 'PO PO-E-SELF', from: `PO Inbox <${MAILBOX}>`, attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-SELF') }] });
        assert.equal(to(MAILBOX).length, 0);
        assert.equal(to(INTERNAL).length, 1);
    });

    test('recipients, reply-to and signature are configurable', async () => {
        Object.assign(process.env, {
            SO_CREATED_EMAIL_TO: 'sales-team@accel4.com', PO_CUSTOMER_EMAIL_REPLY_TO: 'Order Desk <orders@accel4.com>', PO_CUSTOMER_EMAIL_SIGNATURE: 'ACCEL4 Order Desk',
        });
        const { orders: [order] } = await receive({ subject: 'PO PO-E-CFG', attachments: [{ fileName: 'po.csv', mimeType: 'text/csv', content: csv('PO-E-CFG') }] });
        const [review] = to(BUYER);
        assert.equal(review.headers['reply-to'], '"Order Desk" <orders@accel4.com>');
        assert.match(review.text, /ACCEL4 Order Desk$/);
        await assignCustomer(order.ID);
        await resubmit(order.ID);
        assert.equal(to('sales-team@accel4.com').length, 1, '"created" goes to SO_CREATED_EMAIL_TO');
        assert.equal(to(INTERNAL).length, 1, 'exceptions still go to SO_FAILURE_EMAIL_TO');
    });

    test('uploaded POs: no new e-mails (the uploader sees the result in the app)', async () => {
        const content = csv('PO-U-NEW').toString('base64');
        const review = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'u.csv', mimeType: 'text/csv', content })).data;
        assert.equal(review.status, 'NEEDS_REVIEW');
        const created = (await POST(`${SRV}/uploadPurchaseOrder`, { fileName: 'u2.csv', mimeType: 'text/csv', content: csv('PO-U-NEW2').toString('base64'), customerId: 'ACME' })).data;
        assert.equal(created.status, 'CREATED');
        await notifications.whenIdle();
        assert.equal(mails().length, 0);
        void s4;
    });
});

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { startFakeSmtp, parseMail } from '../support/fake-smtp.js';

// E-mails go to an in-process fake SMTP server; nothing leaves the machine.
// The default recipient (dev.salesops@accel4.com) is used: SO_FAILURE_EMAIL_TO is not set.
const smtp = await startFakeSmtp({ users: { 'mailer@example.com': 'secret' } });
// set again before every test: CAP copies a developer's .env into process.env at startup
const UNSET = ['SO_FAILURE_EMAIL_TO', 'SO_FAILURE_EMAIL_ENABLED', 'SMTP_SECURE'];
const SMTP_ENV = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_REQUIRE_TLS: 'false', // the fake server has no TLS; credentials are only sent in clear to loopback
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 'secret',
    SO_FAILURE_EMAIL_FROM: 'PO2SO Notifications <mailer@example.com>',
};
const resetEnv = () => {
    for (const k of UNSET) delete process.env[k];
    Object.assign(process.env, SMTP_ENV);
};
resetEnv();

const { GET, POST, PATCH } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory', '--with-mocks');

const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const csv = (po, lines) => Buffer.from([HEADER, ...lines.map(([line, mat, qty, uom = 'PCS']) =>
    `${po},2027-05-01,2027-05-20,${line},${mat},Item ${line},${qty},${uom},9.99`)].join('\n')).toString('base64');
const b64 = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url)).toString('base64');

const upload = (fileName, content, customerId = 'ACME') =>
    POST(`${SRV}/uploadPurchaseOrder`, { fileName, mimeType: 'text/csv', content, customerId }).then((r) => r.data);
const resubmit = (ID) => POST(`${SRV}/InboundOrders(${ID})/resubmit`, {}).then((r) => r.data);
const order = async (ID) => (await GET(`${SRV}/InboundOrders(${ID})?$expand=events($orderby=createdAt)`)).data;
// read directly from the database: the notification table is not exposed by the service
const notificationsFor = (ID) => SELECT.from('po2so.FailureNotifications').where({ inboundOrder_ID: ID });
const mailsAbout = (po) => smtp.messages.map((m) => ({ ...m, ...parseMail(m.raw) })).filter((m) => m.subject.includes(`PO ${po} `));

let notifications;
let pipeline;
let s4;
let sapDown = false;

describe('Exception e-mail on failed sales order creation', () => {
    before(async () => {
        // same module instances as the running service
        notifications = await import('../../srv/lib/notifications/index.js');
        pipeline = await import('../../srv/lib/pipeline.js');
        (await import('../../srv/lib/notifications/config.js')).allowSendingInTests(true);
        cds.env.po2so.failureNotification = { retry: { retries: 2, baseDelayMs: 5 } };
        s4 = await cds.connect.to('API_SALES_ORDER_SRV');
        s4.prepend(() => s4.before('*', () => {
            if (sapDown) throw Object.assign(new Error('Error during request to remote service: connect ECONNREFUSED'), { statusCode: 502, reason: { message: 'connect ECONNREFUSED' } });
        }));
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
        sapDown = false;
    });

    test('successful sales order creation -> no e-mail', async () => {
        const result = await upload('ok.csv', b64('sample-po.csv'));
        assert.equal(result.status, 'CREATED', result.errorMessage);
        await notifications.whenIdle();
        assert.equal(smtp.messages.length, 0);
        assert.equal((await notificationsFor(result.ID)).length, 0);
    });

    test('validation failure (no SAP call) -> no e-mail', async () => {
        const result = await upload('review.csv', csv('PO-N-REVIEW', [[10, 'UNKNOWN-MAT', 1]]));
        assert.equal(result.status, 'NEEDS_REVIEW');
        await notifications.whenIdle();
        assert.equal(smtp.messages.length, 0);
    });

    test('SAP rejects the order -> one e-mail to dev.salesops@accel4.com with the failure details', async () => {
        const result = await upload('rejected.csv', csv('PO-N-REJ', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        await notifications.whenIdle();

        const mails = mailsAbout('PO-N-REJ');
        assert.equal(mails.length, 1);
        const [mail] = mails;
        assert.deepEqual(mail.to, ['dev.salesops@accel4.com']);
        assert.equal(mail.from, 'mailer@example.com');
        assert.equal(mail.user, 'mailer@example.com');
        assert.equal(mail.headers.to, 'dev.salesops@accel4.com');
        assert.equal(mail.subject, '[PO2SO] Sales order creation failed: PO PO-N-REJ - ACME Industries Ltd.');
        for (const expected of ['ACME Industries Ltd.', 'PO-N-REJ', 'FAILED - SAP rejected the sales order', 'Material TG99 does not exist',
            'HTTP 400', 'rejected.csv', result.ID, 'ACME-NEW-1']) {
            assert.ok(mail.text.includes(expected), `text contains ${expected}`);
            assert.ok(mail.html.includes(expected), `html contains ${expected}`);
        }
        assert.match(mail.text, /Failed at:\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);

        const [row] = await notificationsFor(result.ID);
        assert.equal(row.status, 'SENT');
        assert.equal(row.failureType, 'SAP_REJECTED');
        assert.equal(row.attempts, 1);
        assert.equal(row.customerName, 'ACME Industries Ltd.');
        assert.equal(row.recipients, 'dev.salesops@accel4.com');
        assert.match(row.smtpResponse, /^250 /);
        assert.ok(row.sentAt && row.failedAt);

        // the order itself is unchanged by the notification
        const o = await order(result.ID);
        assert.equal(o.status, 'FAILED');
        assert.equal(o.events.at(-1).status, 'FAILED');
    });

    test('same failure again (resubmit) -> no duplicate e-mail; a different failure -> new e-mail', async () => {
        const result = await upload('dup-notify.csv', csv('PO-N-DUP', [[10, 'ACME-NEW-1', 3]]));
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-DUP').length, 1);

        for (let i = 0; i < 2; i++) assert.equal((await resubmit(result.ID)).status, 'FAILED');
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-DUP').length, 1, 'identical failure is not e-mailed twice');
        assert.equal((await notificationsFor(result.ID)).length, 1);

        // concurrent identical failures are still notified only once
        await Promise.all([resubmit(result.ID), resubmit(result.ID)]);
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-DUP').length, 1);

        // a new SAP error for the same order is a new failure
        await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'ACME-NEW-2', material: 'TG98' });
        const [item] = (await GET(`${SRV}/InboundItems?$filter=parent_ID eq ${result.ID}`)).data.value;
        await PATCH(`${SRV}/InboundItems(${item.ID})`, { customerMaterial: 'ACME-NEW-2' });
        assert.equal((await resubmit(result.ID)).status, 'FAILED');
        await notifications.whenIdle();
        const mails = mailsAbout('PO-N-DUP');
        assert.equal(mails.length, 2);
        assert.match(mails[1].text, /TG98/);
        assert.equal((await notificationsFor(result.ID)).length, 2);
    });

    test('order already exists in SAP -> e-mail naming the existing order', async () => {
        await s4.run(INSERT.into(s4.entities.A_SalesOrder).entries({
            SalesOrderType: 'OR', SalesOrganization: '1010', DistributionChannel: '10', OrganizationDivision: '00',
            SoldToParty: '0010100001', PurchaseOrderByCustomer: 'PO-N-INSAP',
            to_Item: [{ SalesOrderItem: '10', Material: 'TG11', RequestedQuantity: '1', RequestedQuantityUnit: 'PC' }],
        }));
        const result = await upload('in-sap.csv', csv('PO-N-INSAP', [[10, 'ACME-BOLT-10', 1]]));
        assert.equal(result.status, 'FAILED');
        await notifications.whenIdle();
        const [mail] = mailsAbout('PO-N-INSAP');
        assert.ok(mail);
        assert.match(mail.text, /a sales order for this customer PO already exists in SAP/);
        assert.match(mail.text, /already exists in SAP as sales order \d+/);
        assert.equal((await notificationsFor(result.ID))[0].failureType, 'SAP_DUPLICATE');
    });

    test('SAP not reachable -> e-mail, order stays VALIDATED; repeated outage is not e-mailed again', async () => {
        sapDown = true;
        const result = await upload('down.csv', csv('PO-N-DOWN', [[10, 'ACME-BOLT-10', 2]]));
        assert.equal(result.status, 'VALIDATED');
        assert.equal((await resubmit(result.ID)).status, 'VALIDATED');
        sapDown = false;
        await notifications.whenIdle();

        const mails = mailsAbout('PO-N-DOWN');
        assert.equal(mails.length, 1);
        assert.match(mails[0].text, /NOT CREATED - SAP not reachable; the order is still VALIDATED/);
        assert.match(mails[0].text, /connect ECONNREFUSED/);
        assert.equal((await notificationsFor(result.ID))[0].failureType, 'SAP_UNAVAILABLE');

        assert.equal((await resubmit(result.ID)).status, 'CREATED', 'the order can still be posted');
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-DOWN').length, 1, 'no e-mail for the successful retry');
    });

    test('temporary SMTP error -> retried and sent once', async () => {
        smtp.failNext('MESSAGE', '451 4.3.0 Temporary local problem');
        const result = await upload('smtp-transient.csv', csv('PO-N-TRANS', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-TRANS').length, 1);
        const [row] = await notificationsFor(result.ID);
        assert.equal(row.status, 'SENT');
        assert.equal(row.attempts, 2);
    });

    test('SMTP permanently failing -> order processing unaffected, SEND_FAILED recorded; sent when the failure recurs', async () => {
        smtp.failNext('AUTH', '535 5.7.8 Authentication credentials invalid');
        const result = await upload('smtp-auth.csv', csv('PO-N-AUTH', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        assert.match(result.errorMessage, /SAP rejected the sales order/);
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-AUTH').length, 0);
        let [row] = await notificationsFor(result.ID);
        assert.equal(row.status, 'SEND_FAILED');
        assert.equal(row.attempts, 1, 'authentication errors are not retried');
        assert.match(row.lastError, /535/);
        assert.doesNotMatch(row.lastError, /secret/);

        // still FAILED for the same reason on resubmit -> the unsent notification is sent now
        assert.equal((await resubmit(result.ID)).status, 'FAILED');
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-AUTH').length, 1);
        [row] = await notificationsFor(result.ID);
        assert.equal(row.status, 'SENT');
        assert.equal(row.attempts, 2);
        assert.equal(row.lastError, null);
        assert.equal((await notificationsFor(result.ID)).length, 1);
    });

    test('SMTP server unreachable after all retries -> SEND_FAILED, order unaffected', async () => {
        smtp.failNext('CONNECT', '421 4.3.2 Service not available', 3);
        const result = await upload('smtp-down.csv', csv('PO-N-SMTPDOWN', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        await notifications.whenIdle();
        const [row] = await notificationsFor(result.ID);
        assert.equal(row.status, 'SEND_FAILED');
        assert.equal(row.attempts, 3, '1 attempt + 2 retries');
        assert.match(row.lastError, /421/);
        assert.equal((await order(result.ID)).status, 'FAILED');
    });

    test('e-mail not configured -> no e-mail, no error, order processed normally', async () => {
        delete process.env.SMTP_HOST;
        const result = await upload('unconfigured.csv', csv('PO-N-NOCFG', [[10, 'ACME-NEW-1', 3]]));
        assert.equal(result.status, 'FAILED');
        await notifications.whenIdle();
        assert.equal(smtp.messages.length, 0);
        assert.equal((await notificationsFor(result.ID)).length, 0);
    });

    test('notifications switched off -> no e-mail', async () => {
        process.env.SO_FAILURE_EMAIL_ENABLED = 'false';
        try {
            const result = await upload('disabled.csv', csv('PO-N-OFF', [[10, 'ACME-NEW-1', 3]]));
            assert.equal(result.status, 'FAILED');
            await notifications.whenIdle();
            assert.equal(smtp.messages.length, 0);
        } finally {
            delete process.env.SO_FAILURE_EMAIL_ENABLED;
        }
    });

    test('rolled-back transaction -> nothing is e-mailed', async () => {
        sapDown = true;
        const result = await upload('rollback.csv', csv('PO-N-RB', [[10, 'ACME-BOLT-10', 2]]));
        sapDown = false;
        await notifications.whenIdle();
        smtp.reset();
        await POST(`${SRV}/MaterialMappings`, { soldToParty: '0010100001', customerMaterial: 'ACME-RB-1', material: 'TG97' });
        const [item] = (await GET(`${SRV}/InboundItems?$filter=parent_ID eq ${result.ID}`)).data.value;
        await PATCH(`${SRV}/InboundItems(${item.ID})`, { customerMaterial: 'ACME-RB-1' });

        await assert.rejects(cds.tx(async () => {
            const summary = await pipeline.postSalesOrder(result.ID);
            assert.equal(summary.status, 'FAILED');
            throw new Error('rollback');
        }), /rollback/);
        await notifications.whenIdle();
        assert.equal(mailsAbout('PO-N-RB').length, 0);
        assert.equal((await order(result.ID)).status, 'VALIDATED');
    });

    test('recipient is configurable', async () => {
        process.env.SO_FAILURE_EMAIL_TO = 'ops-a@accel4.com, ops-b@accel4.com';
        try {
            await upload('recipients.csv', csv('PO-N-RCPT', [[10, 'ACME-NEW-1', 3]]));
            await notifications.whenIdle();
            const [mail] = mailsAbout('PO-N-RCPT');
            assert.deepEqual(mail.to, ['ops-a@accel4.com', 'ops-b@accel4.com']);
        } finally {
            delete process.env.SO_FAILURE_EMAIL_TO;
        }
    });
});

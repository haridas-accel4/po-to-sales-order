import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import cds from '@sap/cds';
import { getNotificationConfig, configProblems, addressOf, allowSendingInTests, DEFAULT_RECIPIENT } from '../../srv/lib/notifications/config.js';
import { composeFailureEmail, formatUtc } from '../../srv/lib/notifications/failure-email.js';
import { buildMessage, encodeHeader } from '../../srv/lib/notifications/mime.js';
import { sendMail, isTransientMailError, dotStuff, SmtpError } from '../../srv/lib/notifications/smtp-client.js';
import { dedupKeyOf } from '../../srv/lib/notifications/index.js';
import { startFakeSmtp, parseMail } from '../support/fake-smtp.js';

const ENV_KEYS = ['SO_FAILURE_EMAIL_ENABLED', 'SO_FAILURE_EMAIL_TO', 'SO_FAILURE_EMAIL_FROM',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_USER', 'SMTP_PASSWORD'];

// CAP copies a local .env into process.env on first use of cds.env: load it now, so the
// variables reset below stay reset and a developer's .env cannot influence these tests.
void cds.env.po2so;

function withEnv(values) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, values);
}

const ORDER = {
    ID: '11111111-2222-3333-4444-555555555555', customerId: 'ACME', soldToParty: '0010100001', customerPoNumber: 'PO-2027-0042',
    poDate: '2027-05-01', requestedDeliveryDate: '2027-05-20', source: 'UPLOAD', fileName: 'po.csv', status: 'FAILED',
};
const CUSTOMER = { customerId: 'ACME', customerName: 'ACME Industries Ltd.', soldToParty: '0010100001', salesOrganization: '1010', distributionChannel: '10', division: '00' };
const ITEMS = [
    { lineNumber: 20, customerMaterial: 'ACME-NUT-10', material: 'TG12', description: 'Hex nut', quantity: '5.000', sapUom: 'PC' },
    { lineNumber: 10, customerMaterial: 'ACME-NEW-1', material: 'TG99', description: 'New part', quantity: '3', sapUom: 'PC' },
];
const FAILURE = { failureType: 'SAP_REJECTED', messages: ['Item 10: Material TG99 does not exist'], httpStatus: 400, failedAt: '2027-05-02T08:09:10.123Z' };

describe('failure notification config', () => {
    before(() => allowSendingInTests(true));
    after(() => {
        allowSendingInTests(false);
        withEnv({});
    });

    test('under node --test sending is off unless a test opts in (a local .env cannot make tests send mail)', () => {
        withEnv({ SMTP_HOST: 'smtp.x.example', SO_FAILURE_EMAIL_FROM: 'bot@x.example', SO_FAILURE_EMAIL_ENABLED: 'true' });
        allowSendingInTests(false);
        assert.equal(getNotificationConfig().enabled, false);
        allowSendingInTests(true);
        assert.equal(getNotificationConfig().enabled, true);
    });

    test('default recipient is dev.salesops@accel4.com, enabled, STARTTLS on 587', () => {
        withEnv({});
        const c = getNotificationConfig();
        assert.equal(DEFAULT_RECIPIENT, 'dev.salesops@accel4.com');
        assert.deepEqual(c.recipients, ['dev.salesops@accel4.com']);
        assert.equal(c.enabled, true);
        assert.equal(c.smtp.port, 587);
        assert.equal(c.smtp.secure, false);
        assert.equal(c.smtp.requireTls, true);
    });

    test('recipients, sender and SMTP settings come from the environment', () => {
        withEnv({ SO_FAILURE_EMAIL_TO: 'a@x.example; b@x.example', SMTP_HOST: 'smtp.x.example', SMTP_SECURE: 'true', SMTP_USER: 'bot@x.example', SMTP_PASSWORD: 'pw', SO_FAILURE_EMAIL_ENABLED: 'false' });
        const c = getNotificationConfig();
        assert.deepEqual(c.recipients, ['a@x.example', 'b@x.example']);
        assert.equal(c.smtp.port, 465);
        assert.equal(c.from, 'bot@x.example', 'SMTP login is the default sender');
        assert.equal(c.enabled, false);
        assert.deepEqual(configProblems(c), []);
    });

    test('missing / invalid settings are reported without secrets', () => {
        withEnv({ SO_FAILURE_EMAIL_TO: 'not-an-address', SMTP_USER: 'login-name', SMTP_PASSWORD: '' });
        const problems = configProblems(getNotificationConfig());
        assert.ok(problems.some((p) => /SMTP_HOST/.test(p)));
        assert.ok(problems.some((p) => /SO_FAILURE_EMAIL_FROM is not set/.test(p)));
        assert.ok(problems.some((p) => /invalid address.*not-an-address/.test(p)));
        assert.ok(problems.some((p) => /SMTP_PASSWORD/.test(p)));
    });

    test('addressOf accepts "Name <addr>" and rejects header injection', () => {
        assert.equal(addressOf('PO2SO <noreply@accel4.com>'), 'noreply@accel4.com');
        assert.equal(addressOf('x@y.example'), 'x@y.example');
        assert.equal(addressOf('x@y.example\r\nBcc: evil@z.example'), null);
        assert.equal(addressOf('nobody'), null);
    });
});

describe('failure e-mail content', () => {
    test('contains customer, PO, status, SAP message, failure time and PO details', () => {
        const { subject, text, html } = composeFailureEmail({ failure: FAILURE, order: ORDER, customer: CUSTOMER, items: ITEMS });
        assert.equal(subject, '[PO2SO] Sales order creation failed: PO PO-2027-0042 - ACME Industries Ltd.');
        for (const expected of ['ACME Industries Ltd.', 'PO-2027-0042', 'FAILED - SAP rejected the sales order', 'HTTP 400',
            'Material TG99 does not exist', '2027-05-02 08:09:10 UTC', '0010100001', '1010 / 10 / 00', '2027-05-01', 'po.csv', ORDER.ID]) {
            assert.ok(text.includes(expected), `text contains ${expected}`);
            assert.ok(html.includes(expected), `html contains ${expected}`);
        }
        // items sorted by line
        assert.ok(text.indexOf('ACME-NEW-1') < text.indexOf('ACME-NUT-10'));
    });

    test('SAP unavailable: order not created but still VALIDATED', () => {
        const { text } = composeFailureEmail({ failure: { ...FAILURE, failureType: 'SAP_UNAVAILABLE', httpStatus: 502 }, order: { ...ORDER, status: 'VALIDATED' }, customer: CUSTOMER });
        assert.match(text, /NOT CREATED - SAP not reachable; the order is still VALIDATED/);
    });

    test('Gmail origin is included; document values are escaped and kept on one subject line', () => {
        const order = { ...ORDER, source: 'EMAIL', customerPoNumber: 'PO<1>\r\nBcc: x@y' };
        const { subject, html } = composeFailureEmail({
            failure: { ...FAILURE, messages: ['<script>alert(1)</script>'] }, order, customer: CUSTOMER,
            email: { sender: 'Buyer <buyer@customer.example>', subject: 'Purchase Order 42', receivedAt: '2027-05-02T07:00:00Z' },
        });
        assert.doesNotMatch(subject, /[\r\n]/);
        assert.match(html, /&lt;script&gt;/);
        assert.doesNotMatch(html, /<script>/);
        assert.match(html, /Buyer &lt;buyer@customer\.example&gt;/);
        assert.match(html, /Purchase Order 42/);
    });

    test('formatUtc', () => {
        assert.equal(formatUtc('2027-01-02T03:04:05.678Z'), '2027-01-02 03:04:05 UTC');
        assert.equal(formatUtc(null), '-');
    });
});

describe('MIME message', () => {
    test('headers, UTF-8 subject and base64 bodies round-trip', () => {
        const { raw, envelope, messageId } = buildMessage({
            from: 'PO2SO Notifications <noreply@accel4.com>', to: ['dev.salesops@accel4.com'],
            subject: 'Sales order failed: Müller GmbH – PO 1', text: 'Grüße\n.line starting with dot', html: '<p>Grüße</p>',
            date: new Date('2027-05-02T08:09:10Z'),
        });
        assert.deepEqual(envelope, { from: 'noreply@accel4.com', to: ['dev.salesops@accel4.com'] });
        assert.match(messageId, /^<[0-9a-f-]+@accel4\.com>$/);
        const mail = parseMail(raw);
        assert.equal(mail.headers.from, '"PO2SO Notifications" <noreply@accel4.com>');
        assert.equal(mail.headers.to, 'dev.salesops@accel4.com');
        assert.equal(mail.headers.date, 'Sun, 02 May 2027 08:09:10 +0000');
        assert.equal(mail.subject, 'Sales order failed: Müller GmbH – PO 1');
        assert.equal(mail.text, 'Grüße\n.line starting with dot');
        assert.equal(mail.html, '<p>Grüße</p>');
        assert.ok(raw.split('\r\n').every((l) => l.length <= 998));
    });

    test('header values never contain line breaks', () => {
        assert.equal(encodeHeader('a\r\nBcc: x@y'), 'a Bcc: x@y');
        assert.throws(() => buildMessage({ from: 'x', to: ['a@b.example'], subject: '', text: '', html: '' }), /Invalid sender/);
    });

    test('dot-stuffing and CRLF', () => {
        assert.equal(dotStuff('a\n.b\r\n..c'), 'a\r\n..b\r\n...c\r\n.');
    });
});

describe('dedup key', () => {
    test('same order, type and messages -> same key; anything else -> different key', () => {
        const base = { orderId: 'o1', failureType: 'SAP_REJECTED', messages: ['Material TG99 does not exist'] };
        assert.equal(dedupKeyOf(base), dedupKeyOf({ ...base, messages: ['  Material   TG99 does not exist '] }));
        assert.notEqual(dedupKeyOf(base), dedupKeyOf({ ...base, orderId: 'o2' }));
        assert.notEqual(dedupKeyOf(base), dedupKeyOf({ ...base, failureType: 'SAP_UNAVAILABLE' }));
        assert.notEqual(dedupKeyOf(base), dedupKeyOf({ ...base, messages: ['Material TG98 does not exist'] }));
        assert.match(dedupKeyOf(base), /^[0-9a-f]{64}$/);
    });
});

describe('error classification', () => {
    test('SMTP 4xx and network errors are transient; 5xx, auth and TLS errors are not', () => {
        assert.equal(isTransientMailError(new SmtpError('x', { responseCode: 421 })), true);
        assert.equal(isTransientMailError(new SmtpError('x', { responseCode: 451 })), true);
        assert.equal(isTransientMailError(new SmtpError('x', { code: 'ECONNECTION' })), true);
        assert.equal(isTransientMailError(new SmtpError('x', { code: 'ETIMEDOUT' })), true);
        assert.equal(isTransientMailError(new SmtpError('x', { code: 'EAUTH', responseCode: 535 })), false);
        assert.equal(isTransientMailError(new SmtpError('x', { code: 'EENVELOPE', responseCode: 550 })), false);
        assert.equal(isTransientMailError(new SmtpError('x', { code: 'ETLS' })), false);
        assert.equal(isTransientMailError(new Error('bug')), false);
    });
});

describe('SMTP client (against a local fake server)', () => {
    let smtp;
    const settings = () => ({ host: '127.0.0.1', port: smtp.port, secure: false, requireTls: false, user: 'mailer@example.com', password: 'secret', timeoutMs: 5000 });
    const message = () => ({ from: 'mailer@example.com', to: ['dev.salesops@accel4.com', 'second@accel4.com'], raw: 'Subject: t\r\n\r\nhello\r\n.dot line' });

    before(async () => { smtp = await startFakeSmtp(); });
    after(() => smtp.close());
    beforeEach(() => smtp.reset());

    test('AUTH PLAIN, envelope and dot-stuffed data', async () => {
        const { response } = await sendMail(settings(), message());
        assert.match(response, /^250 .*queued/);
        assert.equal(smtp.messages.length, 1);
        const [m] = smtp.messages;
        assert.equal(m.user, 'mailer@example.com');
        assert.equal(m.from, 'mailer@example.com');
        assert.deepEqual(m.to, ['dev.salesops@accel4.com', 'second@accel4.com']);
        assert.equal(m.raw, 'Subject: t\r\n\r\nhello\r\n.dot line');
    });

    test('AUTH LOGIN when PLAIN is not offered', async () => {
        const loginOnly = await startFakeSmtp({ authMechanisms: 'LOGIN' });
        try {
            await sendMail({ ...settings(), port: loginOnly.port }, message());
            assert.deepEqual(loginOnly.stats.authenticated, ['mailer@example.com']);
            assert.equal(loginOnly.messages.length, 1);
        } finally {
            await loginOnly.close();
        }
    });

    test('wrong password -> EAUTH (permanent), message text has no credentials', async () => {
        const e = await sendMail({ ...settings(), password: 'wrong-secret' }, message()).then(() => null, (err) => err);
        assert.equal(e.code, 'EAUTH');
        assert.equal(e.responseCode, 535);
        assert.equal(isTransientMailError(e), false);
        assert.doesNotMatch(e.message, /wrong-secret|bWFpbGVy/);
        assert.equal(smtp.messages.length, 0);
    });

    test('rejected recipient -> EENVELOPE; 4xx on data -> transient', async () => {
        smtp.failNext('RCPT', '550 5.1.1 User unknown');
        const rcpt = await sendMail(settings(), message()).then(() => null, (err) => err);
        assert.equal(rcpt.code, 'EENVELOPE');
        assert.equal(rcpt.responseCode, 550);

        smtp.failNext('MESSAGE', '451 4.3.0 Try again later');
        const data = await sendMail(settings(), message()).then(() => null, (err) => err);
        assert.equal(data.responseCode, 451);
        assert.equal(isTransientMailError(data), true);
        assert.equal(smtp.messages.length, 0);
    });

    test('server without STARTTLS is refused unless TLS is explicitly not required', async () => {
        const e = await sendMail({ ...settings(), requireTls: true }, message()).then(() => null, (err) => err);
        assert.equal(e.code, 'ETLS');
        assert.equal(smtp.messages.length, 0);
    });

    test('server not reachable -> ECONNECTION (transient)', async () => {
        const closed = await startFakeSmtp();
        const { port } = closed;
        await closed.close();
        const e = await sendMail({ ...settings(), port }, message()).then(() => null, (err) => err);
        assert.equal(e.code, 'ECONNECTION');
        assert.equal(isTransientMailError(e), true);
    });
});

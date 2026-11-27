import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { createFakeGmail, gmailError } from '../support/fake-gmail.js';

// Gmail is never contacted: the client factory is replaced by an in-memory fake and the
// OAuth credentials live in a temporary file.
const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po2so-gmail-test-'));
Object.assign(process.env, {
    GMAIL_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
    GMAIL_REDIRECT_URI: 'http://localhost:4004/auth/gmail/callback',
    GMAIL_TOKEN_FILE: path.join(tokenDir, 'gmail-token.json'),
    GMAIL_AUTO_POLL_ENABLED: 'false',
});

const { GET, POST, axios } = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');

const SRV = '/odata/v4/sales-order';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const csv = (po) => Buffer.from(`${HEADER}\n${po},2027-05-01,2027-05-20,10,ACME-BOLT-10,Hex bolt,10,PCS,0.25\n`);
const MAILBOX = 'po-inbox@example.com';

let gmail; // modules loaded after cds.test started the server (same instances as the service)
let intake;
let tokens;
let clientModule;
let fake;

async function expectError(promise, status) {
    try {
        await promise;
    } catch (e) {
        assert.equal(e.response?.status ?? e.status, status, JSON.stringify(e.response?.data ?? e.message));
        return e.response?.data?.error ?? e;
    }
    assert.fail(`expected HTTP ${status}`);
}

const status = async () => (await GET(`${SRV}/gmailStatus()`)).data;
const check = async (body = {}) => (await POST(`${SRV}/checkGmailNow`, body)).data;
const emailOrders = async () => (await GET(`${SRV}/InboundOrders?$filter=source eq 'EMAIL'&$orderby=createdAt,fileName` +
    '&$expand=emailAttachment($expand=message)')).data.value;
const messageRow = async (gmailMessageId) => (await GET(`${SRV}/EmailMessages?$filter=gmailMessageId eq '${gmailMessageId}'&$expand=attachments($orderby=partId)`)).data.value[0];

/** Simulate a completed OAuth connection: credentials stored, cursor at connection time. */
async function connect(connectedAt = Date.now() - 60_000) {
    fake = createFakeGmail({ emailAddress: MAILBOX });
    clientModule.setGmailClientFactory(() => fake.client);
    tokens.saveCredentials({ refreshToken: 'fake-refresh-token', emailAddress: MAILBOX, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    const at = new Date(connectedAt).toISOString();
    await cds.tx(() => intake.writeSyncState({ emailAddress: MAILBOX, connectedAt: at, cursor: at, lastError: null }));
}

describe('Gmail intake', () => {
    before(async () => {
        cds.env.po2so.autoPost = false; // keep orders open; posting is covered elsewhere
        cds.env.po2so.gmail = { retry: { retries: 2, baseDelayMs: 1 }, maxAttempts: 3, revokeOnDisconnect: false };
        gmail = await import('../../srv/lib/gmail/index.js');
        intake = await import('../../srv/lib/gmail/intake.js');
        tokens = await import('../../srv/lib/gmail/token-store.js');
        clientModule = await import('../../srv/lib/gmail/gmail-client.js');
    });
    after(() => fs.rmSync(tokenDir, { recursive: true, force: true }));

    describe('disconnected', () => {
        test('status shows configured but not connected; no secrets in the response', async () => {
            const s = await status();
            assert.equal(s.configured, true);
            assert.equal(s.connected, false);
            assert.equal(s.emailAddress, null);
            assert.equal(s.keywords, 'Purchase Order, PO, Sales Order, SO');
            assert.doesNotMatch(JSON.stringify(s), /secret|refresh|token/i);
        });

        test('checkGmailNow is rejected with 409 GMAIL_NOT_CONNECTED', async () => {
            const err = await expectError(check(), 409);
            assert.equal(err.code, 'GMAIL_NOT_CONNECTED');
        });

        test('invalid backfillDays -> 400', async () => {
            const err = await expectError(check({ backfillDays: 0 }), 400);
            assert.equal(err.code, 'INVALID_BACKFILL');
        });
    });

    describe('OAuth endpoints', () => {
        test('connect redirects to Google with read-only scope, offline access and a state cookie', async () => {
            const res = await axios.get('/auth/gmail/connect', { maxRedirects: 0, validateStatus: () => true });
            assert.equal(res.status, 302);
            const url = new URL(res.headers.location);
            assert.equal(url.host, 'accounts.google.com');
            assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
            assert.equal(url.searchParams.get('access_type'), 'offline');
            assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4004/auth/gmail/callback');
            const state = url.searchParams.get('state');
            assert.ok(state && state.length >= 40);
            const cookie = [].concat(res.headers['set-cookie'] ?? []).join(';');
            assert.match(cookie, new RegExp(`po2so_gmail_oauth_state=${state}`));
            assert.match(cookie, /HttpOnly/i);
            assert.doesNotMatch(res.headers.location, /client_secret/);
        });

        test('callback rejects a missing, unknown or foreign state (CSRF) with 400', async () => {
            const call = (query, cookie) => axios.get(`/auth/gmail/callback?${query}`, {
                maxRedirects: 0, validateStatus: () => true, headers: cookie ? { Cookie: cookie } : {},
            });
            assert.equal((await call('code=abc')).status, 400);
            assert.equal((await call('code=abc&state=forged', 'po2so_gmail_oauth_state=forged')).status, 400);

            // a real state, but presented without / with another browser's cookie
            const start = await axios.get('/auth/gmail/connect', { maxRedirects: 0, validateStatus: () => true });
            const state = new URL(start.headers.location).searchParams.get('state');
            assert.equal((await call(`code=abc&state=${state}`)).status, 400);
            assert.equal((await call(`code=abc&state=${state}`, 'po2so_gmail_oauth_state=other')).status, 400);
        });

        test('callback with valid state and user denial redirects back to the app; the state is single-use', async () => {
            const start = await axios.get('/auth/gmail/connect', { maxRedirects: 0, validateStatus: () => true });
            const state = new URL(start.headers.location).searchParams.get('state');
            const cookie = `po2so_gmail_oauth_state=${state}`;
            const res = await axios.get(`/auth/gmail/callback?error=access_denied&state=${state}`, { maxRedirects: 0, validateStatus: () => true, headers: { Cookie: cookie } });
            assert.equal(res.status, 302);
            assert.match(res.headers.location, /^\/sales-order\/webapp\/index\.html\?gmail=error/);
            const again = await axios.get(`/auth/gmail/callback?code=abc&state=${state}`, { maxRedirects: 0, validateStatus: () => true, headers: { Cookie: cookie } });
            assert.equal(again.status, 400);
        });
    });

    describe('connected', () => {
        beforeEach(async () => { await connect(); });

        test('status: connected address, counters, no tokens', async () => {
            const s = await status();
            assert.equal(s.connected, true);
            assert.equal(s.emailAddress, MAILBOX);
            assert.equal(s.autoPollEnabled, false);
            assert.doesNotMatch(JSON.stringify(s), /fake-refresh-token/);
        });

        test('multiple supported attachments -> one inbound order each, through the normal pipeline', async () => {
            const id = fake.addMessage({
                subject: 'Purchase Order 4711 and 4712',
                text: 'Please process the attached orders.',
                from: 'Jane Buyer <jane@acme.example>',
                attachments: [
                    { fileName: 'po-4711.csv', mimeType: 'text/csv', content: csv('PO-MAIL-4711') },
                    { fileName: 'po-4712.xlsx', mimeType: XLSX_MIME, content: fixture('sample-po.xlsx') },
                    { fileName: 'logo.png', mimeType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), inline: true },
                    { fileName: 'terms.docx', mimeType: 'application/msword', content: 'doc' },
                ],
            });
            const before = (await emailOrders()).length;
            const result = await check();
            assert.equal(result.attachmentsProcessed, 2);
            assert.equal(result.messagesCompleted, 1);
            assert.equal(result.complete, true);

            const orders = (await emailOrders()).slice(before);
            assert.equal(orders.length, 2);
            for (const o of orders) {
                assert.equal(o.source, 'EMAIL');
                // no customer can be derived from the mail -> existing review mechanism
                assert.equal(o.status, 'NEEDS_REVIEW');
                assert.equal(o.customerId, null);
                assert.equal(o.emailAttachment.message.sender, 'Jane Buyer <jane@acme.example>');
                assert.equal(o.emailAttachment.message.subject, 'Purchase Order 4711 and 4712');
                assert.equal(o.emailAttachment.gmailMessageId, id);
            }
            assert.deepEqual(orders.map((o) => o.fileName).sort(), ['po-4711.csv', 'po-4712.xlsx']);
            const csvOrder = orders.find((o) => o.fileName === 'po-4711.csv');
            assert.equal(csvOrder.customerPoNumber, 'PO-MAIL-4711');
            assert.equal(csvOrder.extractionMethod, 'CSV_TEMPLATE_V1');

            // original attachment preserved byte-for-byte
            const file = await GET(`${SRV}/InboundFiles(${csvOrder.file_ID})/content`, { responseType: 'arraybuffer' });
            assert.equal(Buffer.from(file.data).toString(), csv('PO-MAIL-4711').toString());

            const msg = await messageRow(id);
            assert.equal(msg.status, 'COMPLETED');
            assert.equal(msg.matchedKeyword, 'Purchase Order');
            assert.equal(msg.supportedAttachments, 2);
            assert.equal(msg.attachments.length, 2);

            // a reviewer assigns the customer -> revalidation through the existing review flow
            const patched = await axios.patch(`${SRV}/InboundOrders(${csvOrder.ID})`, { customerId: 'ACME' });
            assert.equal(patched.status, 200);
            const reviewed = (await GET(`${SRV}/InboundOrders(${csvOrder.ID})`)).data;
            assert.equal(reviewed.status, 'VALIDATED');
            assert.equal(reviewed.soldToParty, '0010100001');
        });

        test('the customer is identified from the attachment or the e-mail (customer identifiers)', async () => {
            await axios.patch(`${SRV}/Customers('GLOBEX')`, { identifiers: 'globex.example' });
            await axios.patch(`${SRV}/Customers('ACME')`, { identifiers: 'ACME Industries Ltd' });
            try {
                fake.addMessage({
                    subject: 'Purchase Order 4801', from: 'Buyer <buyer@globex.example>', text: 'Order attached.',
                    attachments: [{ fileName: 'po-4801.csv', mimeType: 'text/csv', content: csv('PO-MAIL-4801') }],
                });
                fake.addMessage({
                    subject: 'Purchase Order 4802', from: 'Buyer <buyer@globex.example>', text: 'Order attached.',
                    attachments: [{ fileName: 'po-4802.csv', mimeType: 'text/csv',
                        content: Buffer.from(`${HEADER}\nPO-MAIL-4802,2027-05-01,2027-05-20,10,ACME-BOLT-10,Hex bolt for ACME Industries Ltd,10,PCS,0.25\n`) }],
                });
                const before = (await emailOrders()).length;
                await check();
                const orders = (await emailOrders()).slice(before);
                const byPo = Object.fromEntries(orders.map((o) => [o.customerPoNumber, o]));
                assert.equal(byPo['PO-MAIL-4801'].customerId, 'GLOBEX');   // from the sender
                assert.equal(byPo['PO-MAIL-4802'].customerId, 'ACME');     // the attachment wins over the sender
            } finally {
                await axios.patch(`${SRV}/Customers('GLOBEX')`, { identifiers: null });
                await axios.patch(`${SRV}/Customers('ACME')`, { identifiers: null });
            }
        });

        test('repeated polls and backfills never process a message or attachment twice', async () => {
            fake.addMessage({ subject: 'PO 5001', attachments: [{ fileName: 'po-5001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-5001') }] });
            const first = await check();
            assert.equal(first.attachmentsProcessed, 1);
            const count = (await emailOrders()).length;
            const gets = fake.calls.get;

            const second = await check();
            const backfill = await check({ backfillDays: 30 });
            assert.equal(second.attachmentsProcessed, 0);
            assert.equal(backfill.attachmentsProcessed, 0);
            assert.equal((await emailOrders()).length, count);
            assert.equal(fake.calls.get, gets, 'known messages are skipped without fetching them again');
        });

        test('the database refuses a second record for the same attachment', async () => {
            const id = fake.addMessage({ subject: 'PO 5002', attachments: [{ fileName: 'po-5002.csv', mimeType: 'text/csv', content: csv('PO-MAIL-5002') }] });
            await check();
            const row = (await messageRow(id)).attachments[0];
            await assert.rejects(cds.tx(() => INSERT.into('po2so.EmailAttachments').entries({
                mailbox: row.mailbox, gmailMessageId: row.gmailMessageId, partId: row.partId, status: 'PROCESSED',
            })), /UNIQUE/i);
            await assert.rejects(cds.tx(() => INSERT.into('po2so.EmailMessages').entries({ mailbox: MAILBOX, gmailMessageId: id, status: 'COMPLETED' })), /UNIQUE/i);
        });

        test('keyword in the body only (HTML-only mail) is processed; unrelated mail is ignored', async () => {
            const html = fake.addMessage({
                subject: 'Weekly update',
                html: '<html><head><title>x</title></head><body><p>Attached is our <b>purchase&nbsp;order</b>.</p></body></html>',
                attachments: [{ fileName: 'order.csv', mimeType: 'text/csv', content: csv('PO-MAIL-HTML') }],
            });
            const unrelated = fake.addMessage({
                subject: 'Holiday photos', text: 'See the report and the photo.',
                attachments: [{ fileName: 'report.csv', mimeType: 'text/csv', content: csv('NOT-A-PO') }],
            });
            const result = await check();
            assert.equal(result.attachmentsProcessed, 1);
            assert.equal((await messageRow(html)).status, 'COMPLETED');
            const ignored = await messageRow(unrelated);
            assert.equal(ignored.status, 'IGNORED');
            assert.match(ignored.ignoreReason, /keyword/);
            assert.equal(ignored.attachments.length, 0);
            assert.ok(!(await emailOrders()).some((o) => o.customerPoNumber === 'NOT-A-PO'));
        });

        test('matching mail without supported attachments is ignored', async () => {
            const id = fake.addMessage({
                subject: 'Sales Order confirmation', text: 'See attachments',
                attachments: [{ fileName: 'scan.jpg', mimeType: 'image/jpeg', content: 'jpg' }, { fileName: 'order.docx', mimeType: 'application/msword', content: 'doc' }],
            });
            await check();
            const msg = await messageRow(id);
            assert.equal(msg.status, 'IGNORED');
            assert.match(msg.ignoreReason, /supported attachment/);
        });

        test('first connection does not import older mail; an explicit backfill does', async () => {
            const old = fake.addMessage({
                subject: 'PO from last week', receivedAt: Date.now() - 7 * 24 * 3600 * 1000,
                attachments: [{ fileName: 'old-po.csv', mimeType: 'text/csv', content: csv('PO-MAIL-OLD') }],
            });
            await check();
            assert.equal(await messageRow(old), undefined);
            const result = await check({ backfillDays: 10 });
            assert.equal(result.attachmentsProcessed, 1);
            assert.equal((await messageRow(old)).status, 'COMPLETED');
            assert.match(fake.calls.queries.at(-1), /has:attachment/);
        });

        test('temporary Gmail API failures are retried', async () => {
            const id = fake.addMessage({ subject: 'PO 6001', attachments: [{ fileName: 'po-6001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-6001') }] });
            fake.failList(gmailError(503, 'Backend Error'));
            fake.failGet(id, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
            fake.failAttachment(id, gmailError(429, 'Rate Limit Exceeded'));
            const result = await check();
            assert.equal(result.attachmentsProcessed, 1);
            assert.equal((await messageRow(id)).status, 'COMPLETED');
        });

        test('a failing attachment does not block the others and is retried on the next poll', async () => {
            const id = fake.addMessage({
                subject: 'POs 7001-7003',
                attachments: [
                    { fileName: 'po-7001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-7001') },
                    { fileName: 'po-7002.csv', mimeType: 'text/csv', content: csv('PO-MAIL-7002') },
                    { fileName: 'fake.pdf', mimeType: 'application/pdf', content: 'this is not a pdf' },
                ],
            });
            // attachment 2 keeps failing for this poll (more failures than retries)
            fake.failAttachmentAt(id, 1, ...Array.from({ length: 3 }, () => gmailError(500, 'Internal error')));

            const first = await check();
            assert.equal(first.attachmentsProcessed, 1);
            assert.equal(first.attachmentsRejected, 1);
            assert.equal(first.attachmentsFailed, 1);
            let msg = await messageRow(id);
            assert.equal(msg.status, 'RETRY');
            assert.deepEqual(msg.attachments.map((a) => [a.fileName, a.status]),
                [['po-7001.csv', 'PROCESSED'], ['po-7002.csv', 'FAILED'], ['fake.pdf', 'REJECTED']]);
            assert.equal(msg.attachments[2].errorCode, 'CONTENT_MISMATCH');
            assert.equal((await status()).attachmentsFailed >= 2, true);

            const second = await check();
            assert.equal(second.attachmentsProcessed, 1);
            msg = await messageRow(id);
            assert.equal(msg.status, 'COMPLETED');
            assert.deepEqual(msg.attachments.map((a) => a.status), ['PROCESSED', 'PROCESSED', 'REJECTED']);
            const pos = (await emailOrders()).map((o) => o.customerPoNumber);
            assert.equal(pos.filter((p) => p === 'PO-MAIL-7001').length, 1);
            assert.equal(pos.filter((p) => p === 'PO-MAIL-7002').length, 1);
        });

        test('a message that keeps failing is marked FAILED after the maximum attempts', async () => {
            const id = fake.addMessage({ subject: 'PO 8001', attachments: [{ fileName: 'po-8001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-8001') }] });
            fake.failAttachment(id, ...Array.from({ length: 20 }, () => gmailError(503)));
            await check();
            await check();
            await check();
            const msg = await messageRow(id);
            assert.equal(msg.status, 'FAILED');
            assert.equal(msg.attempts, 3);
            assert.equal(msg.attachments[0].status, 'FAILED');
            const calls = fake.calls.get;
            await check();
            assert.equal(fake.calls.get, calls, 'FAILED messages are not fetched again automatically');
        });

        test('restart: processing history survives; an interrupted message resumes without duplicates', async () => {
            const id = fake.addMessage({
                subject: 'PO 9001 + 9002',
                attachments: [
                    { fileName: 'po-9001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-9001') },
                    { fileName: 'po-9002.csv', mimeType: 'text/csv', content: csv('PO-MAIL-9002') },
                ],
            });
            await check();
            const ordersBefore = (await emailOrders()).length;

            // simulate a crash after the first attachment: message left PROCESSING, second attachment never recorded
            const msg = await messageRow(id);
            await cds.tx(async () => {
                await UPDATE('po2so.EmailMessages', msg.ID).with({ status: 'PROCESSING' });
                await DELETE.from('po2so.EmailAttachments').where({ ID: msg.attachments[1].ID });
                await DELETE.from('po2so.InboundOrders').where({ ID: msg.attachments[1].inboundOrder_ID });
            });

            // "new process": fresh Gmail client, cursor lost -> the whole window is listed again
            const restarted = createFakeGmail({ emailAddress: MAILBOX });
            restarted.addMessage({ id, subject: 'PO 9001 + 9002', attachments: [
                { fileName: 'po-9001.csv', mimeType: 'text/csv', content: csv('PO-MAIL-9001') },
                { fileName: 'po-9002.csv', mimeType: 'text/csv', content: csv('PO-MAIL-9002') },
            ] });
            clientModule.setGmailClientFactory(() => restarted.client);
            await cds.tx(() => intake.writeSyncState({ cursor: null, connectedAt: new Date(Date.now() - 3600_000).toISOString() }));

            const result = await check();
            assert.equal(result.attachmentsProcessed, 1, 'only the missing attachment is processed');
            const after = await messageRow(id);
            assert.equal(after.status, 'COMPLETED');
            assert.equal((await emailOrders()).length, ordersBefore);
            assert.equal(restarted.calls.attachment, 1);
        });

        test('overlapping sync requests share one run', async () => {
            fake.addMessage({ subject: 'PO 9101', attachments: [{ fileName: 'po-9101.csv', mimeType: 'text/csv', content: csv('PO-MAIL-9101') }] });
            fake.setListDelay(300); // keep the first run busy while the second request arrives
            const [a, b] = await Promise.all([check(), check()]);
            fake.setListDelay(0);
            assert.equal(a.attachmentsProcessed + b.attachmentsProcessed, 2, 'the same run reported twice');
            assert.ok(a.joined || b.joined);
            assert.equal((await emailOrders()).filter((o) => o.customerPoNumber === 'PO-MAIL-9101').length, 1);
        });

        test('an expired / revoked grant is reported and asks for reconnecting', async () => {
            fake.failList(gmailError(400, 'invalid_grant'));
            const err = await expectError(check(), 409);
            assert.equal(err.code, 'GMAIL_RECONNECT_REQUIRED');
            assert.match(err.message, /connect Gmail again/i);
            assert.match((await status()).lastError, /authorization is no longer valid/i);
        });

        test('manual upload still works unchanged next to Gmail intake', async () => {
            const { data } = await POST(`${SRV}/uploadPurchaseOrder`, {
                fileName: 'manual.csv', mimeType: 'text/csv', content: csv('PO-MANUAL-1').toString('base64'), customerId: 'ACME',
            });
            assert.equal(data.status, 'VALIDATED');
            const o = (await GET(`${SRV}/InboundOrders(${data.ID})?$expand=emailAttachment`)).data;
            assert.equal(o.source, 'UPLOAD');
            assert.equal(o.emailAttachment, null);
        });

        test('emailAttachment cannot be changed through the API', async () => {
            const [o] = await emailOrders();
            const err = await expectError(axios.patch(`${SRV}/InboundOrders(${o.ID})`, { emailAttachment: null }), 400);
            assert.match(err.message, /system-managed/);
        });

        test('disconnect clears the stored credentials and keeps the history', async () => {
            const historyBefore = (await GET(`${SRV}/EmailMessages/$count`)).data;
            const s = (await POST(`${SRV}/disconnectGmail`, {})).data;
            assert.equal(s.connected, false);
            assert.equal(fs.existsSync(process.env.GMAIL_TOKEN_FILE), false);
            assert.equal((await GET(`${SRV}/EmailMessages/$count`)).data, historyBefore);
            await expectError(check(), 409);
        });
    });
});

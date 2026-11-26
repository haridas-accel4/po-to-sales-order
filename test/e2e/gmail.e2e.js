/* global sap, window, document */ // used inside browser-evaluated callbacks
/**
 * Browser tests for the Gmail intake UI: settings dialog, Connect redirect, Check Gmail Now,
 * source column, Gmail details in the review dialog and disconnect.
 *
 *   npm run test:e2e
 *
 * Gmail is never contacted: the server uses an in-memory fake Gmail client, the OAuth
 * redirect to Google is intercepted in the browser, and credentials live in a temp file.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { createFakeGmail } from '../support/fake-gmail.js';

const BROWSERS = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = BROWSERS.find((p) => fs.existsSync(p));

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po2so-gmail-e2e-'));
Object.assign(process.env, {
    GMAIL_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'e2e-client-secret',
    GMAIL_TOKEN_FILE: path.join(tokenDir, 'gmail-token.json'),
    GMAIL_AUTO_POLL_ENABLED: 'false',
});

const app = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const csv = (po) => Buffer.from(`${HEADER}\n${po},2027-05-01,2027-05-20,10,ACME-BOLT-10,Hex bolt,10,PCS,0.25\n`);
const VIEW = 'container-po2so.salesorder---app';
const P = VIEW + '--';
const byId = (id) => `[id="${P}${id}"]`;

describe('Gmail intake in the browser', { skip: !executablePath && 'no Chrome/Edge found (set CHROME_PATH)' }, () => {
    let browser; let page; let fake; const consoleErrors = []; let googleUrl = null;

    const model = (name, p) => page.evaluate(([v, n, pp]) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel(n).getProperty(pp), [VIEW, name, p]);
    const idle = (id) => page.waitForFunction((cid) => {
        const d = sap.ui.require('sap/ui/core/Element').getElementById(cid);
        return d && d.isOpen() && !d.getBusy();
    }, P + id);
    const messageBoxText = async () => (await page.locator('.sapMMessageBox').last().innerText()).replace(/\s+/g, ' ');
    const closeMessageBox = () => page.locator('.sapMMessageBox').last().locator('footer button:visible, .sapMDialogFooter button:visible').last().click();
    const openApp = async (query = '') => {
        await page.goto(app.url + '/sales-order/webapp/index.html' + query);
        await page.getByText('Purchase Order Processing').waitFor({ timeout: 60000 });
        await page.waitForFunction(() => window.sap?.ui?.require?.('sap/ui/core/Element'));
        await page.waitForFunction((id) => !sap.ui.require('sap/ui/core/Element').getElementById(id).getBusy(), P + 'poTable');
    };

    before(async () => {
        cds.env.po2so.autoPost = false;
        cds.env.po2so.gmail = { ...cds.env.po2so.gmail, revokeOnDisconnect: false, retry: { retries: 1, baseDelayMs: 1 } };
        const { chromium } = await import('playwright-core');
        browser = await chromium.launch({ executablePath });
        page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('console', (m) => { if (m.type() === 'error' && !/Component-preload|unload is not allowed|404 \(Not Found\)|40[09] \(/.test(m.text())) consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));
        // never leave localhost: let the server answer /auth/gmail/connect, but stop at its redirect to Google
        await page.route('**/auth/gmail/connect', async (route) => {
            const response = await route.fetch({ maxRedirects: 0 });
            googleUrl = response.headers().location;
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Google consent (intercepted)</body></html>' });
        });
        await page.route('https://accounts.google.com/**', (route) => route.abort());
        await openApp();
    });
    after(async () => {
        await browser?.close();
        fs.rmSync(tokenDir, { recursive: true, force: true });
    });

    test('Gmail dialog shows "Not connected" and Connect leads to Google with read-only scope', async () => {
        await page.locator(byId('gmailButton')).click();
        await idle('gmailDialog');
        assert.equal(await model('gmail', '/view/connectionText'), 'Not connected');
        assert.equal(await page.locator(byId('gmailCheckButton')).isDisabled(), true);
        await page.locator(byId('gmailConnectButton')).click();
        await page.getByText('Google consent (intercepted)').waitFor();
        const url = new URL(googleUrl);
        assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
        assert.equal(url.searchParams.get('access_type'), 'offline');
        assert.ok(url.searchParams.get('state'));
    });

    test('after the OAuth redirect the dialog shows the connected mailbox', async () => {
        // what the callback does after a successful code exchange
        const tokens = await import('../../srv/lib/gmail/token-store.js');
        const intake = await import('../../srv/lib/gmail/intake.js');
        const clientModule = await import('../../srv/lib/gmail/gmail-client.js');
        fake = createFakeGmail({ emailAddress: 'po-inbox@example.com' });
        clientModule.setGmailClientFactory(() => fake.client);
        tokens.saveCredentials({ refreshToken: 'e2e-refresh', emailAddress: 'po-inbox@example.com' });
        const at = new Date(Date.now() - 60_000).toISOString();
        await cds.tx(() => intake.writeSyncState({ emailAddress: 'po-inbox@example.com', connectedAt: at, cursor: at }));

        await openApp('?gmail=connected');
        await idle('gmailDialog');
        assert.equal(await page.evaluate(() => window.location.search), '', 'redirect parameters are removed from the URL');
        assert.equal(await model('gmail', '/view/connectionText'), 'Connected');
        assert.equal(await page.locator(byId('gmailAddress')).innerText(), 'po-inbox@example.com');
        assert.equal(await page.locator(byId('gmailDisconnectButton')).isVisible(), true);
        assert.doesNotMatch(JSON.stringify(await model('gmail', '/status')), /e2e-refresh|secret/i);
    });

    test('Check Gmail Now imports attachments; the table shows the source', async () => {
        fake.addMessage({
            subject: 'Purchase Order PO-E2E-MAIL', from: 'Jane Buyer <jane@acme.example>', text: 'Please deliver.',
            attachments: [{ fileName: 'po-e2e-mail.csv', mimeType: 'text/csv', content: csv('PO-E2E-MAIL') }],
        });
        await page.locator(byId('gmailCheckButton')).click();
        await page.locator('.sapMMessageBox').waitFor();
        assert.match(await messageBoxText(), /1 new email\(s\) checked, 1 attachment\(s\) processed/);
        await closeMessageBox();
        await idle('gmailDialog');
        assert.equal(await page.locator(byId('gmailAttachmentsProcessed')).innerText(), '1');
        assert.notEqual(await page.locator(byId('gmailLastChecked')).innerText(), 'Never');
        await page.locator(byId('gmailDialog')).getByRole('button', { name: 'Close' }).click();

        // the upload tab shows the upload form; the table lives in the other tabs
        await page.locator('.sapMITBFilter', { hasText: 'Processed POs' }).first().click();
        await page.waitForFunction(() => document.querySelector('[id$="--poTable"]')?.innerText.includes('PO-E2E-MAIL'));
        const records = await model('records', '/records');
        const mail = records.find((r) => r.poNumber === 'PO-E2E-MAIL');
        assert.equal(mail.sourceText, 'Gmail');
        assert.match(mail.sourceTooltip, /Jane Buyer/);
    });

    test('review dialog shows sender, subject and attachment of a Gmail order', async () => {
        await page.locator('.sapMITBFilter', { hasText: 'Exceptions' }).first().click();
        await page.locator(`${byId('poTable')} tr`, { hasText: 'PO-E2E-MAIL' }).first().click();
        await idle('reviewDialog');
        assert.equal(await page.locator(byId('reviewEmailPanel')).isVisible(), true);
        assert.equal(await page.locator(byId('reviewEmailSender')).innerText(), 'Jane Buyer <jane@acme.example>');
        assert.equal(await page.locator(byId('reviewEmailSubject')).innerText(), 'Purchase Order PO-E2E-MAIL');
        assert.match(await page.locator(byId('reviewSource')).innerText(), /Gmail/);
        await page.locator(byId('reviewDialog')).getByRole('button', { name: 'Close' }).click();
    });

    test('manual upload still works and is labelled Manual Upload', async () => {
        await page.locator('.sapMITBFilter', { hasText: 'PO Upload' }).first().click();
        const file = path.join(tokenDir, 'po-e2e-manual.csv');
        fs.writeFileSync(file, csv('PO-E2E-MANUAL'));
        await page.locator(`${byId('poFileUploader')} input[type=file]`).setInputFiles(file);
        await page.locator(byId('uploadButton')).click();
        // no customer selected -> warning, upload only after confirming
        const warning = page.getByRole('alertdialog').filter({ hasText: 'No customer is selected' });
        await warning.getByRole('button', { name: 'Upload Anyway' }).click();
        await page.waitForFunction((id) => sap.ui.require('sap/ui/core/Element').getElementById(id).getVisible(), P + 'uploadResult');
        await page.locator('.sapMITBFilter', { hasText: 'Processed POs' }).first().click();
        await page.waitForFunction(() => document.querySelector('[id$="--poTable"]')?.innerText.includes('PO-E2E-MANUAL'));
        const manual = (await model('records', '/records')).find((r) => r.poNumber === 'PO-E2E-MANUAL');
        assert.equal(manual.sourceText, 'Manual Upload');
        // the review dialog has no Gmail panel for uploads
        await page.locator('.sapMITBFilter', { hasText: 'Exceptions' }).first().click();
        await page.locator(`${byId('poTable')} tr`, { hasText: 'PO-E2E-MANUAL' }).first().click();
        await idle('reviewDialog');
        assert.equal(await page.locator(byId('reviewEmailPanel')).isVisible(), false);
        await page.locator(byId('reviewDialog')).getByRole('button', { name: 'Close' }).click();
    });

    test('disconnect asks for confirmation and clears the connection', async () => {
        await page.locator(byId('gmailButton')).click();
        await idle('gmailDialog');
        await page.locator(byId('gmailDisconnectButton')).click();
        await page.locator('.sapMMessageBox').waitFor();
        assert.match(await messageBoxText(), /Disconnect po-inbox@example\.com\?/);
        await page.locator('.sapMMessageBox').last().getByRole('button', { name: 'OK' }).click();
        await page.waitForFunction(() => document.querySelector('.sapMMessageToast')?.innerText.includes('disconnected'));
        assert.equal(await model('gmail', '/view/connectionText'), 'Not connected');
        assert.equal(fs.existsSync(process.env.GMAIL_TOKEN_FILE), false);
        await page.locator(byId('gmailDialog')).getByRole('button', { name: 'Close' }).click();
    });

    test('no browser console errors', () => {
        assert.deepEqual(consoleErrors, []);
    });
});

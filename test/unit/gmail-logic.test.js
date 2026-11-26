import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUi5Module } from '../support/load-ui5-module.js';

const gmailLogic = loadUi5Module(new URL('../../app/sales-order/webapp/model/gmailLogic.js', import.meta.url));
const fmt = (iso) => `at ${iso}`;
const BASE = { configured: true, connected: true, emailAddress: 'po@example.com', autoPollEnabled: true, pollIntervalMinutes: 5, polling: false };

describe('gmailLogic (UI)', () => {
    test('source labels distinguish Manual Upload and Gmail', () => {
        assert.equal(gmailLogic.sourceText('UPLOAD'), 'Manual Upload');
        assert.equal(gmailLogic.sourceText('EMAIL'), 'Gmail');
    });

    test('status view: not configured / not connected / connected / reconnect required', () => {
        const notConfigured = gmailLogic.statusView({ configured: false, connected: false, autoPollEnabled: true, pollIntervalMinutes: 5 }, fmt);
        assert.equal(notConfigured.connectionText, 'Not configured');
        assert.equal(notConfigured.canConnect, false);
        assert.match(notConfigured.notConfiguredHint, /GMAIL_CLIENT_ID/);

        const disconnected = gmailLogic.statusView({ ...BASE, connected: false, emailAddress: null }, fmt);
        assert.equal(disconnected.connectionText, 'Not connected');
        assert.equal(disconnected.canConnect, true);
        assert.equal(disconnected.canCheck, false);
        assert.equal(disconnected.emailAddress, '–');

        const connected = gmailLogic.statusView({ ...BASE, nextPollAt: '2027-01-01T10:05:00Z', lastCheckedAt: '2027-01-01T10:00:00Z' }, fmt);
        assert.equal(connected.connectionText, 'Connected');
        assert.equal(connected.connectionState, 'Success');
        assert.equal(connected.canCheck, true);
        assert.equal(connected.canDisconnect, true);
        assert.equal(connected.pollingText, 'On, every 5 min (next: at 2027-01-01T10:05:00Z)');
        assert.equal(connected.lastCheckedText, 'at 2027-01-01T10:00:00Z');
        assert.equal(connected.lastSuccessText, 'Never');

        const expired = gmailLogic.statusView({ ...BASE, lastError: 'Gmail authorization is no longer valid (invalid_grant).' }, fmt);
        assert.equal(expired.connectionText, 'Reconnect required');
        assert.equal(expired.connectionState, 'Error');

        assert.equal(gmailLogic.statusView({ ...BASE, polling: true }, fmt).canCheck, false);
        assert.match(gmailLogic.statusView({ ...BASE, autoPollEnabled: false }, fmt).pollingText, /^Off/);
    });

    test('sync summary', () => {
        const text = gmailLogic.syncSummary({ messagesChecked: 3, attachmentsProcessed: 2, messagesIgnored: 1, attachmentsRejected: 1, attachmentsFailed: 1, complete: false });
        assert.match(text, /^3 new email\(s\) checked, 2 attachment\(s\) processed/);
        assert.match(text, /1 email\(s\) ignored/);
        assert.match(text, /rejected by file validation/);
        assert.match(text, /will be retried/);
        assert.match(text, /next check/);
    });

    test('email origin for Gmail orders, null for uploads', () => {
        assert.equal(gmailLogic.emailOrigin({ fileName: 'a.csv', emailAttachment: null }, fmt), null);
        assert.deepEqual(gmailLogic.emailOrigin({
            fileName: 'a.csv',
            emailAttachment: { fileName: 'a.csv', message: { sender: 'B <b@x>', subject: 'PO 1', receivedAt: '2027-01-01T00:00:00Z' } },
        }, fmt), { sender: 'B <b@x>', subject: 'PO 1', fileName: 'a.csv', receivedAt: 'at 2027-01-01T00:00:00Z' });
    });
});

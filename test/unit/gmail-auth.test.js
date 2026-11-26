import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueState, consumeState, authorizationUrl, STATE_TTL_MS } from '../../srv/lib/gmail/oauth.js';
import { saveCredentials, loadCredentials, clearCredentials } from '../../srv/lib/gmail/token-store.js';
import { withRetry, isTransient, isAuthError, safeErrorMessage } from '../../srv/lib/gmail/retry.js';

const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('OAuth state (CSRF protection)', () => {
    test('a fresh state with the matching cookie is accepted exactly once', () => {
        const state = issueState();
        assert.deepEqual(consumeState(state, state), { ok: true });
        assert.equal(consumeState(state, state).ok, false);
    });

    test('missing, forged, foreign-cookie and expired states are rejected', () => {
        assert.equal(consumeState(null, null).ok, false);
        assert.equal(consumeState('forged', 'forged').ok, false);
        const state = issueState();
        assert.equal(consumeState(state, null).ok, false);
        assert.equal(consumeState(state, 'another-browser').ok, false);

        const old = issueState(Date.now() - STATE_TTL_MS - 1);
        const result = consumeState(old, old);
        assert.equal(result.ok, false);
    });

    test('authorization URL asks only for gmail.readonly with offline access', () => {
        const url = new URL(authorizationUrl('s1', { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:4004/auth/gmail/callback' }));
        assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
        assert.equal(url.searchParams.get('access_type'), 'offline');
        assert.equal(url.searchParams.get('prompt'), 'consent');
        assert.equal(url.searchParams.get('state'), 's1');
        assert.equal(url.searchParams.get('client_secret'), null);
    });
});

describe('token store', () => {
    let dir;
    let config;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po2so-token-'));
        config = { tokenFile: path.join(dir, 'sub', 'gmail-token.json'), clientSecret: 'secret-1', tokenKey: '' };
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('round-trips credentials and never writes them in plain text', () => {
        saveCredentials({ refreshToken: '1//refresh-abc', emailAddress: 'me@example.com' }, config);
        const raw = fs.readFileSync(config.tokenFile, 'utf8');
        assert.doesNotMatch(raw, /refresh-abc|me@example\.com/);
        const loaded = loadCredentials(config);
        assert.equal(loaded.refreshToken, '1//refresh-abc');
        assert.equal(loaded.emailAddress, 'me@example.com');
    });

    test('cannot be read with another key; clear removes the file', () => {
        assert.equal(loadCredentials({ ...config, clientSecret: 'other' }), null);
        clearCredentials(config);
        assert.equal(fs.existsSync(config.tokenFile), false);
        assert.equal(loadCredentials(config), null);
    });
});

describe('retry of Gmail API calls', () => {
    test('transient errors are retried with backoff, then succeed', async () => {
        let calls = 0;
        const delays = [];
        const result = await withRetry(async () => {
            calls++;
            if (calls === 1) throw httpError(503);
            if (calls === 2) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            return 'ok';
        }, { retries: 3, baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } });
        assert.equal(result, 'ok');
        assert.deepEqual(delays, [10, 20]);
    });

    test('permanent errors are not retried; retries are bounded', async () => {
        let calls = 0;
        await assert.rejects(withRetry(async () => { calls++; throw httpError(404); }, { retries: 3, sleep: async () => {} }));
        assert.equal(calls, 1);
        calls = 0;
        await assert.rejects(withRetry(async () => { calls++; throw httpError(429); }, { retries: 2, sleep: async () => {} }));
        assert.equal(calls, 3);
    });

    test('classification and safe messages', () => {
        assert.equal(isTransient(httpError(500)), true);
        assert.equal(isTransient(httpError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } })), true);
        assert.equal(isTransient(httpError(403)), false);
        assert.equal(isAuthError(httpError(400, { error: 'invalid_grant' })), true);
        assert.equal(isAuthError(httpError(401)), true);
        assert.equal(safeErrorMessage(new Error('failed refresh_token=1//abc&x=1')), 'failed refresh_token=***&x=1');
    });
});

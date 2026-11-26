import { AsyncLocalStorage } from 'node:async_hooks';
import cds from '@sap/cds';
import { getGmailConfig, isConfigured } from './config.js';
import { createGmailClient } from './gmail-client.js';
import { authorizedClient, exchangeCode, revokeToken } from './oauth.js';
import { GmailAuthError, readSyncState, syncMailbox, writeSyncState } from './intake.js';
import { clearCredentials, loadCredentials, saveCredentials } from './token-store.js';
import { safeErrorMessage } from './retry.js';

/**
 * Gmail integration facade used by the service, the OAuth routes and server.js:
 * connection (connect / status / disconnect) and polling (scheduled + "Check Gmail Now").
 */

const LOG = cds.log('gmail');

/**
 * Runs a function outside of any request context. Captured at module load (server start),
 * so a sync started from an OData action does not join that request's transaction:
 * every attachment is committed on its own.
 */
const runDetached = AsyncLocalStorage.snapshot();

let running = null;   // promise of the sync in progress (no overlapping runs)
let timer = null;
let nextPollAt = null;

export class GmailNotConnectedError extends Error {
    constructor(message = 'Gmail is not connected. Connect a Gmail account first.') {
        super(message);
        this.code = 'GMAIL_NOT_CONNECTED';
        this.status = 409;
    }
}

/** Connected = OAuth client configured and a refresh token stored. No database access. */
export function isConnected(config = getGmailConfig()) {
    return isConfigured(config) && !!loadCredentials(config);
}

function apiClient(creds, config) {
    return createGmailClient(authorizedClient(creds.refreshToken, {
        config,
        onRefreshToken: (refreshToken) => saveCredentials({ ...creds, refreshToken }, config),
    }));
}

// ---------------------------------------------------------------- connection

/** OAuth callback: exchange the code, read the mailbox address, store credentials, start at "now". */
export async function completeConnection(code, config = getGmailConfig()) {
    const tokens = await exchangeCode(code, config);
    const creds = { refreshToken: tokens.refreshToken, scope: tokens.scope };
    const { emailAddress } = await apiClient(creds, config).getProfile();
    saveCredentials({ ...creds, emailAddress }, config);
    const now = new Date().toISOString();
    // new emails only: no historical import unless a backfill is requested explicitly
    await cds.tx(() => writeSyncState({ emailAddress, connectedAt: now, cursor: now, lastError: null }));
    LOG.info(`Gmail connected: ${emailAddress}`);
    scheduleNext();
    return { emailAddress };
}

/** Clear stored credentials (and revoke the grant at Google, best effort). History is kept. */
export async function disconnect(config = getGmailConfig()) {
    const creds = loadCredentials(config);
    clearCredentials(config);
    stopPolling();
    if (creds?.refreshToken && isConfigured(config) && config.revokeOnDisconnect !== false) {
        const revoked = await revokeToken(creds.refreshToken, config);
        if (!revoked) LOG.warn('Gmail token could not be revoked at Google; local credentials were removed.');
    }
    await writeSyncState({ emailAddress: null, connectedAt: null, cursor: null, lastError: null });
    LOG.info('Gmail disconnected');
}

/** Connection, polling and processing figures for the UI. Never contains secrets. */
export async function getStatus(config = getGmailConfig()) {
    const { EmailMessages, EmailAttachments } = cds.entities('po2so');
    const creds = isConfigured(config) ? loadCredentials(config) : null;
    const state = await readSyncState();
    const count = async (entity, where) => (await SELECT.one.from(entity).columns('count(1) as n').where(where)).n;
    return {
        configured: isConfigured(config),
        connected: !!creds,
        emailAddress: creds ? (creds.emailAddress ?? state.emailAddress ?? null) : null,
        autoPollEnabled: config.autoPollEnabled,
        pollIntervalMinutes: config.pollIntervalMinutes,
        polling: !!running,
        nextPollAt: creds && config.autoPollEnabled && nextPollAt ? new Date(nextPollAt).toISOString() : null,
        connectedAt: creds ? state.connectedAt ?? null : null,
        lastCheckedAt: state.lastCheckedAt ?? null,
        lastSuccessAt: state.lastSuccessAt ?? null,
        lastError: state.lastError ?? null,
        emailsChecked: await count(EmailMessages, { status: { '!=': null } }),
        attachmentsProcessed: await count(EmailAttachments, { status: 'PROCESSED' }),
        attachmentsFailed: await count(EmailAttachments, { status: { in: ['FAILED', 'REJECTED'] } }),
        keywords: config.keywords.map((k) => (typeof k === 'string' ? k : k.term)).join(', '),
    };
}

// ---------------------------------------------------------------- polling

/**
 * Run one sync now. If a sync is already running, waits for it and returns its result
 * (never two runs at the same time).
 * @param {{backfillDays?:number}} [options]
 */
export function runSync(options = {}) {
    const config = getGmailConfig();
    if (!isConnected(config)) return Promise.reject(new GmailNotConnectedError());
    if (running) return running.then((r) => ({ ...r, joined: true }));
    running = runDetached(() => doSync(options, config)).finally(() => { running = null; });
    return running;
}

async function doSync({ backfillDays = null }, config) {
    const creds = loadCredentials(config);
    if (!creds) throw new GmailNotConnectedError();
    const now = Date.now();
    try {
        const client = apiClient(creds, config);
        let mailbox = creds.emailAddress;
        if (!mailbox) {
            mailbox = (await client.getProfile()).emailAddress;
            saveCredentials({ ...creds, emailAddress: mailbox }, config);
        }
        const summary = await syncMailbox({ client, mailbox, backfillDays, now, config });
        const at = new Date().toISOString();
        await cds.tx(() => writeSyncState({
            lastCheckedAt: at,
            lastSuccessAt: at,
            lastError: summary.errors.length ? `${summary.errors.length} attachment/message error(s); last: ${summary.errors.at(-1)}`.slice(0, 1000) : null,
        }));
        LOG.info(`Gmail sync: ${summary.messagesChecked} message(s) checked, ${summary.attachmentsProcessed} attachment(s) processed, ` +
            `${summary.attachmentsRejected} rejected, ${summary.attachmentsFailed} failed`);
        return { ...summary, joined: false };
    } catch (e) {
        const message = e instanceof GmailAuthError ? e.message : `Gmail sync failed: ${safeErrorMessage(e)}`;
        LOG.error(message);
        await cds.tx(() => writeSyncState({ lastCheckedAt: new Date().toISOString(), lastError: message.slice(0, 1000) })).catch(() => {});
        // 409 (not 401) for an expired grant: the app user is authenticated, the Gmail link is not
        throw Object.assign(new Error(message), {
            code: e instanceof GmailAuthError ? 'GMAIL_RECONNECT_REQUIRED' : 'GMAIL_SYNC_FAILED',
            status: e instanceof GmailAuthError ? 409 : 502,
        });
    }
}

/** (Re)schedule the next automatic poll, if enabled and connected. */
export function scheduleNext() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextPollAt = null;
    const config = getGmailConfig();
    if (!config.autoPollEnabled || !isConnected(config)) return;
    const delay = config.pollIntervalMinutes * 60 * 1000;
    nextPollAt = Date.now() + delay;
    timer = runDetached(() => setTimeout(async () => {
        try {
            await runSync();
        } catch (e) {
            if (!(e instanceof GmailNotConnectedError)) LOG.error(`Scheduled Gmail poll failed: ${e.message}`);
        } finally {
            scheduleNext();
        }
    }, delay));
    timer.unref?.();
}

/** Start automatic polling (server start). */
export function startPolling() {
    const config = getGmailConfig();
    if (!config.autoPollEnabled) {
        LOG.info('Gmail automatic polling is disabled (GMAIL_AUTO_POLL_ENABLED=false).');
        return;
    }
    if (!isConnected(config)) {
        LOG.info(isConfigured(config) ? 'Gmail not connected; polling starts after connecting.' : 'Gmail not configured; polling inactive.');
        return;
    }
    LOG.info(`Gmail polling every ${config.pollIntervalMinutes} minute(s).`);
    scheduleNext();
}

export function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextPollAt = null;
}

/** Test hook: wait for a running sync to finish. */
export async function idle() {
    if (running) await running.catch(() => {});
}

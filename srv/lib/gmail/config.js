import os from 'node:os';
import path from 'node:path';
import cds from '@sap/cds';

/** Read-only Gmail access only: the app never sends, deletes, modifies or labels mail. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const DEFAULTS = {
    /** Keywords searched in subject and body; strings or { term, caseSensitive }. */
    keywords: ['Purchase Order', 'PO', 'Sales Order', 'SO'],
    /** Attachment types handed to the intake pipeline (file content is validated there). */
    attachmentExtensions: ['pdf', 'xlsx', 'csv'],
    /** Re-read this many minutes before the stored cursor, so nothing is missed at the boundary. */
    overlapMinutes: 10,
    /** New messages fetched per poll; the cursor only advances when a poll saw everything. */
    maxMessagesPerPoll: 50,
    /** Attempts per message before it is marked FAILED (transient errors only). */
    maxAttempts: 5,
    /** Retries of a single Gmail API call on network errors / HTTP 429 / 5xx. */
    retry: { retries: 3, baseDelayMs: 1000 },
    /** Where the browser is sent after the OAuth callback. */
    appUrl: '/sales-order/webapp/index.html',
};

const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
};

/**
 * Gmail settings. Secrets come only from environment variables (never from package.json);
 * behaviour can be tuned in `cds.po2so.gmail` (package.json / .cdsrc.json).
 * Read on every call so tests and restarts pick up changes.
 */
export function getGmailConfig() {
    const env = process.env;
    const cdsCfg = cds.env.po2so?.gmail ?? {};
    const keywords = env.GMAIL_KEYWORDS
        ? env.GMAIL_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean)
        : (cdsCfg.keywords ?? DEFAULTS.keywords);
    const interval = Number(env.GMAIL_POLL_INTERVAL_MINUTES ?? cdsCfg.pollIntervalMinutes ?? 5);

    return {
        ...DEFAULTS,
        ...cdsCfg,
        keywords,
        retry: { ...DEFAULTS.retry, ...(cdsCfg.retry ?? {}) },
        clientId: env.GMAIL_CLIENT_ID || '',
        clientSecret: env.GMAIL_CLIENT_SECRET || '',
        redirectUri: env.GMAIL_REDIRECT_URI || 'http://localhost:4004/auth/gmail/callback',
        pollIntervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : 5,
        autoPollEnabled: bool(env.GMAIL_AUTO_POLL_ENABLED, true),
        tokenFile: env.GMAIL_TOKEN_FILE || path.join(os.homedir(), '.po2so', 'gmail-token.json'),
        tokenKey: env.GMAIL_TOKEN_ENCRYPTION_KEY || '',
    };
}

/** True when the OAuth client is configured (client ID + secret present). */
export function isConfigured(config = getGmailConfig()) {
    return !!(config.clientId && config.clientSecret);
}

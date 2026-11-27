import cds from '@sap/cds';

/**
 * Settings for the sales-order exception e-mails.
 *
 * Sending is a separate SMTP configuration: it never uses the Gmail intake's read-only
 * OAuth client or token. Secrets and addresses come only from environment variables
 * (.env locally, never package.json); behaviour can be tuned in
 * `cds.po2so.failureNotification` (package.json / .cdsrc.json).
 * Read on every call so tests and restarts pick up changes.
 */

export const DEFAULT_RECIPIENT = 'haridas.shinde@accel4.com';

const DEFAULTS = {
    /** Also e-mail when SAP could not be reached (order stays VALIDATED and can be resubmitted). */
    notifyOnSapUnavailable: true,
    /** Retries of one e-mail on network errors / SMTP 4xx replies (exponential backoff). */
    retry: { retries: 3, baseDelayMs: 2000 },
    /** Connection and per-reply timeout towards the SMTP server. */
    timeoutMs: 30000,
    /** A PENDING notification older than this (process stopped mid-send) may be sent again. */
    stalePendingMinutes: 15,
};

const ADDRESS = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+\.[^\s<>@,;:"()[\]\\]+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Under `node --test` CAP still copies .env into process.env (development profile), so a
 * test hitting an SAP failure would e-mail the configured SMTP server. Sending is therefore
 * off in tests unless a test opts in (it then points SMTP_* at a local fake server).
 */
const underTest = !!process.env.NODE_TEST_CONTEXT;
let sendingInTests = false;
export function allowSendingInTests(allow = true) {
    sendingInTests = allow;
}

const bool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
};

/** Bare address of "Name <addr>" or "addr"; null if it is not a plain e-mail address. */
export function addressOf(value) {
    const text = String(value ?? '').trim();
    const m = /<([^<>]*)>\s*$/.exec(text);
    const address = (m ? m[1] : text).trim();
    return ADDRESS.test(address) ? address : null;
}

export const isLoopback = (host) => LOOPBACK.has(String(host).toLowerCase());

export function getNotificationConfig() {
    const env = process.env;
    const cdsCfg = cds.env.po2so?.failureNotification ?? {};
    const secure = bool(env.SMTP_SECURE, false);
    const port = Number(env.SMTP_PORT || (secure ? 465 : 587));
    const user = env.SMTP_USER || '';
    const recipients = String(env.SO_FAILURE_EMAIL_TO || DEFAULT_RECIPIENT)
        .split(/[,;]/).map((r) => r.trim()).filter(Boolean);

    return {
        ...DEFAULTS,
        ...cdsCfg,
        retry: { ...DEFAULTS.retry, ...(cdsCfg.retry ?? {}) },
        enabled: (!underTest || sendingInTests) && bool(env.SO_FAILURE_EMAIL_ENABLED, cdsCfg.enabled ?? true),
        recipients,
        // a mailbox login is usually also the allowed sender
        from: (env.SO_FAILURE_EMAIL_FROM || (addressOf(user) ? user : '')).trim(),
        smtp: {
            host: env.SMTP_HOST || '',
            port: Number.isInteger(port) && port > 0 ? port : 587,
            secure,
            requireTls: bool(env.SMTP_REQUIRE_TLS, true),
            user,
            password: env.SMTP_PASSWORD || '',
        },
    };
}

/** Why e-mails cannot be sent with this configuration (empty = ready). Never contains secrets. */
export function configProblems(config = getNotificationConfig()) {
    const problems = [];
    if (!config.smtp.host) problems.push('SMTP_HOST is not set');
    if (!config.from) problems.push('SO_FAILURE_EMAIL_FROM is not set');
    else if (!addressOf(config.from)) problems.push('SO_FAILURE_EMAIL_FROM is not a valid e-mail address');
    if (!config.recipients.length) problems.push('SO_FAILURE_EMAIL_TO has no recipient');
    const invalid = config.recipients.filter((r) => !addressOf(r) || addressOf(r) !== r);
    if (invalid.length) problems.push(`SO_FAILURE_EMAIL_TO contains invalid address(es): ${invalid.join(', ')}`);
    if (config.smtp.user && !config.smtp.password) problems.push('SMTP_PASSWORD is not set for SMTP_USER');
    return problems;
}

export const isConfigured = (config = getNotificationConfig()) => configProblems(config).length === 0;

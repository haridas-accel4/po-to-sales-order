import cds from '@sap/cds';
import { getGmailConfig, isConfigured } from './config.js';
import { STATE_COOKIE, STATE_TTL_MS, authorizationUrl, consumeState, issueState } from './oauth.js';
import { completeConnection } from './index.js';
import { safeErrorMessage } from './retry.js';

const LOG = cds.log('gmail');
const COOKIE_PATH = '/auth/gmail';

function readCookie(header, name) {
    for (const part of String(header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
}

function backToApp(res, config, params) {
    res.redirect(`${config.appUrl}?${new URLSearchParams(params)}`);
}

/**
 * OAuth endpoints on CAP's own Express app (no separate server):
 *   GET /auth/gmail/connect   -> redirect to Google's consent screen (gmail.readonly)
 *   GET /auth/gmail/callback  -> validate state, exchange code, store credentials, back to the app
 * Tokens never leave the server; the browser only sees the redirect.
 */
export function registerGmailRoutes(app) {
    app.get(`${COOKIE_PATH}/connect`, (req, res) => {
        const config = getGmailConfig();
        if (!isConfigured(config)) {
            return res.status(503).type('text/plain')
                .send('Gmail is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (see docs/gmail-setup.md) and restart the server.');
        }
        const state = issueState();
        res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: STATE_TTL_MS, path: COOKIE_PATH });
        res.redirect(authorizationUrl(state, config));
    });

    app.get(`${COOKIE_PATH}/callback`, async (req, res) => {
        const config = getGmailConfig();
        const cookieState = readCookie(req.headers.cookie, STATE_COOKIE);
        res.clearCookie(STATE_COOKIE, { path: COOKIE_PATH });

        const check = consumeState(typeof req.query.state === 'string' ? req.query.state : null, cookieState);
        if (!check.ok) {
            LOG.warn(`Gmail OAuth callback rejected: ${check.reason}`);
            return res.status(400).type('text/plain').send(`Gmail connection rejected: ${check.reason}`);
        }
        if (req.query.error) {
            return backToApp(res, config, { gmail: 'error', message: `Google did not grant access (${String(req.query.error).slice(0, 100)}).` });
        }
        if (typeof req.query.code !== 'string' || !req.query.code) {
            return res.status(400).type('text/plain').send('Gmail connection rejected: authorization code missing.');
        }
        try {
            await completeConnection(req.query.code, config);
            backToApp(res, config, { gmail: 'connected' });
        } catch (e) {
            const message = safeErrorMessage(e);
            LOG.error(`Gmail connection failed: ${message}`);
            backToApp(res, config, { gmail: 'error', message });
        }
    });
}

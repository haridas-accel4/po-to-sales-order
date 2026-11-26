import { randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import { GMAIL_SCOPE, getGmailConfig } from './config.js';

/**
 * OAuth 2.0 (authorization code flow, offline access) for one Gmail mailbox.
 *
 * CSRF protection: every authorization request gets a random, single-use `state` that
 * expires after 10 minutes. It is kept server-side and in an HttpOnly cookie; the callback
 * is accepted only if the returned state is known, unexpired, unused and equal to the
 * cookie of the same browser.
 */

export const STATE_COOKIE = 'po2so_gmail_oauth_state';
export const STATE_TTL_MS = 10 * 60 * 1000;

const pendingStates = new Map(); // state -> expiresAt

export function createOAuthClient(config = getGmailConfig()) {
    return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

/** New state value, remembered until it is used or expires. */
export function issueState(now = Date.now()) {
    for (const [s, exp] of pendingStates) if (exp <= now) pendingStates.delete(s);
    const state = randomBytes(32).toString('base64url');
    pendingStates.set(state, now + STATE_TTL_MS);
    return state;
}

const sameString = (a, b) => {
    const x = Buffer.from(String(a ?? ''));
    const y = Buffer.from(String(b ?? ''));
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/**
 * Validate and consume a state returned to the callback.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function consumeState(state, cookieState, now = Date.now()) {
    if (!state) return { ok: false, reason: 'Missing OAuth state.' };
    if (!sameString(state, cookieState)) return { ok: false, reason: 'OAuth state does not match this browser session.' };
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state); // single use, also when expired
    if (!expiresAt) return { ok: false, reason: 'Unknown or already used OAuth state.' };
    if (expiresAt <= now) return { ok: false, reason: 'OAuth state expired; start the connection again.' };
    return { ok: true };
}

/** Google consent screen URL (read-only scope, offline access for a refresh token). */
export function authorizationUrl(state, config = getGmailConfig()) {
    return createOAuthClient(config).generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // always return a refresh token, also when re-connecting
        scope: [GMAIL_SCOPE],
        include_granted_scopes: false,
        state,
    });
}

/**
 * Exchange the authorization code. Rejects grants without a refresh token or with
 * scopes other than gmail.readonly being required for the app to work.
 * @returns {Promise<{refreshToken:string, accessToken:string, scope:string, expiryDate:number}>}
 */
export async function exchangeCode(code, config = getGmailConfig()) {
    const client = createOAuthClient(config);
    const { tokens } = await client.getToken(code);
    const scopes = String(tokens.scope ?? '').split(/\s+/).filter(Boolean);
    if (!scopes.includes(GMAIL_SCOPE)) {
        throw new Error('Gmail read-only access was not granted. Allow "View your email messages and settings" on the consent screen.');
    }
    if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.');
    }
    return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, scope: tokens.scope, expiryDate: tokens.expiry_date };
}

/** Authorized OAuth client for API calls; persists a rotated refresh token via onRefreshToken. */
export function authorizedClient(refreshToken, { onRefreshToken, config = getGmailConfig() } = {}) {
    const client = createOAuthClient(config);
    client.setCredentials({ refresh_token: refreshToken });
    if (onRefreshToken) {
        client.on('tokens', (tokens) => {
            if (tokens.refresh_token && tokens.refresh_token !== refreshToken) onRefreshToken(tokens.refresh_token);
        });
    }
    return client;
}

/** Best effort: revoke the grant at Google (the local credentials are cleared regardless). */
export async function revokeToken(refreshToken, config = getGmailConfig()) {
    try {
        await createOAuthClient(config).revokeToken(refreshToken);
        return true;
    } catch {
        return false;
    }
}

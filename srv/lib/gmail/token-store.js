import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { getGmailConfig } from './config.js';

/**
 * Persistent store for the Gmail OAuth credentials (refresh token + connected address).
 *
 * Local development: an AES-256-GCM encrypted JSON file outside the project folder
 * (default ~/.po2so/gmail-token.json, override with GMAIL_TOKEN_FILE), so it survives
 * restarts and can never be committed. The key is GMAIL_TOKEN_ENCRYPTION_KEY if set,
 * otherwise derived from GMAIL_CLIENT_SECRET.
 *
 * Production: replace this module with one backed by a managed secret store
 * (e.g. SAP BTP Credential Store) implementing the same load / save / clear functions.
 * Tokens are never written to the database and never returned to the frontend.
 */

const VERSION = 1;

function keyFor(config, salt) {
    const secret = config.tokenKey || config.clientSecret;
    if (!secret) throw new Error('Gmail token encryption needs GMAIL_TOKEN_ENCRYPTION_KEY or GMAIL_CLIENT_SECRET.');
    return scryptSync(createHash('sha256').update(secret).digest(), salt, 32);
}

export function encrypt(data, config = getGmailConfig()) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFor(config, salt), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return { v: VERSION, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') };
}

export function decrypt(box, config = getGmailConfig()) {
    if (!box || box.v !== VERSION) throw new Error('Unsupported Gmail token file format.');
    const decipher = createDecipheriv('aes-256-gcm', keyFor(config, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
}

/**
 * @returns {{refreshToken:string, emailAddress?:string, scope?:string, savedAt?:string}|null}
 *   null if nothing is stored or the file cannot be decrypted (e.g. the client secret changed)
 */
export function loadCredentials(config = getGmailConfig()) {
    let raw;
    try {
        raw = fs.readFileSync(config.tokenFile, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
    try {
        const data = decrypt(JSON.parse(raw), config);
        return data?.refreshToken ? data : null;
    } catch {
        return null;
    }
}

export function saveCredentials(data, config = getGmailConfig()) {
    fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true, mode: 0o700 });
    const tmp = `${config.tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(encrypt({ ...data, savedAt: new Date().toISOString() }, config)), { mode: 0o600 });
    fs.renameSync(tmp, config.tokenFile);
}

export function clearCredentials(config = getGmailConfig()) {
    fs.rmSync(config.tokenFile, { force: true });
}

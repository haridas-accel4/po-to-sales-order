import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { isLoopback } from './config.js';

/**
 * Minimal SMTP submission client (RFC 5321) on Node's built-in net / tls - enough to hand
 * one message to a provider's submission server (Google Workspace, Microsoft 365, SendGrid,
 * a company relay ...), without an extra dependency:
 *
 *   implicit TLS (port 465, SMTP_SECURE=true) or STARTTLS (port 587; required by default)
 *   AUTH PLAIN / AUTH LOGIN, MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT
 *
 * Credentials are only sent over TLS (plain text is allowed to a loopback relay only, e.g.
 * a local test server). Errors never contain credentials or the message content.
 */

export class SmtpError extends Error {
    /** @param {{code?:string, responseCode?:number, cause?:Error}} [details] */
    constructor(message, { code = 'ESMTP', responseCode = null, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'SmtpError';
        this.code = code;
        this.responseCode = responseCode;
    }
}

const TRANSIENT_CODES = new Set(['ECONNECTION', 'ETIMEDOUT']);

/** SMTP 4xx replies and network problems are temporary; 5xx, TLS and auth problems are not. */
export function isTransientMailError(error) {
    if (!error) return false;
    if (Number.isInteger(error.responseCode)) return error.responseCode >= 400 && error.responseCode < 500;
    return TRANSIENT_CODES.has(error.code);
}

/** Reads complete (possibly multi-line) replies from the current socket. */
class Connection {
    constructor(timeoutMs) {
        this.timeoutMs = timeoutMs;
        this.replies = [];
        this.waiters = [];
        this.failure = null;
        this.buffer = '';
        this.lines = [];
        this.socket = null;
        this.handlers = null;
    }

    use(socket) {
        this.detach();
        this.socket = socket;
        this.handlers = {
            data: (chunk) => this.onData(chunk),
            error: (e) => this.fail(new SmtpError(`SMTP connection error: ${e.message}`, { code: 'ECONNECTION', cause: e })),
            close: () => this.fail(new SmtpError('SMTP connection closed unexpectedly', { code: 'ECONNECTION' })),
            timeout: () => {
                this.fail(new SmtpError(`SMTP server did not answer within ${this.timeoutMs} ms`, { code: 'ETIMEDOUT' }));
                socket.destroy();
            },
        };
        for (const [event, fn] of Object.entries(this.handlers)) socket.on(event, fn);
        socket.setTimeout(this.timeoutMs);
    }

    detach() {
        if (!this.socket || !this.handlers) return;
        for (const [event, fn] of Object.entries(this.handlers)) this.socket.off(event, fn);
        this.socket.setTimeout(0);
        this.handlers = null;
    }

    onData(chunk) {
        this.buffer += chunk.toString('utf8');
        let i;
        while ((i = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, i).replace(/\r$/, '');
            this.buffer = this.buffer.slice(i + 1);
            this.lines.push(line);
            if (/^\d{3}(?: |$)/.test(line)) { // last line of a reply ("250 ok"; "250-..." continues)
                const reply = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
                this.lines = [];
                const waiter = this.waiters.shift();
                if (waiter) waiter.resolve(reply);
                else this.replies.push(reply);
            }
        }
    }

    fail(error) {
        if (this.failure) return;
        this.failure = error;
        for (const w of this.waiters.splice(0)) w.reject(error);
    }

    read() {
        if (this.replies.length) return Promise.resolve(this.replies.shift());
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    /**
     * Send one command line (null = only read, e.g. the greeting) and check the reply code.
     * `label` names the step in errors - the line itself may contain credentials.
     */
    async command(line, expected, label, code = 'EPROTOCOL') {
        if (line !== null) this.socket.write(`${line}\r\n`);
        const reply = await this.read();
        if (!expected.includes(reply.code)) {
            throw new SmtpError(`SMTP ${label} failed: ${reply.code} ${reply.lines.join(' ').slice(0, 300)}`, { code, responseCode: reply.code });
        }
        return reply;
    }

    close() {
        const socket = this.socket;
        this.detach();
        if (socket && !socket.destroyed) {
            socket.on('error', () => {}); // late errors after QUIT are irrelevant
            socket.end();
            setTimeout(() => socket.destroy(), 1000).unref();
        }
    }
}

function open({ host, port, secure, timeoutMs, rejectUnauthorized }) {
    return new Promise((resolve, reject) => {
        const socket = secure
            ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized })
            : net.connect({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new SmtpError(`Connection to SMTP server ${host}:${port} timed out`, { code: 'ETIMEDOUT' }));
        }, timeoutMs);
        const onError = (e) => {
            clearTimeout(timer);
            reject(new SmtpError(`Cannot connect to SMTP server ${host}:${port}: ${e.message}`, { code: 'ECONNECTION', cause: e }));
        };
        socket.once('error', onError);
        socket.once(secure ? 'secureConnect' : 'connect', () => {
            clearTimeout(timer);
            socket.off('error', onError);
            resolve(socket);
        });
    });
}

function upgrade(socket, host, rejectUnauthorized) {
    return new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }, () => resolve(secured));
        secured.once('error', (e) => reject(new SmtpError(`STARTTLS negotiation failed: ${e.message}`, { code: 'ETLS', cause: e })));
    });
}

/** EHLO keywords, e.g. Map { 'STARTTLS' => '', 'AUTH' => 'PLAIN LOGIN' } */
function extensions(ehloReply) {
    const map = new Map();
    for (const line of ehloReply.lines.slice(1)) {
        const [keyword, ...rest] = line.trim().split(/[\s=]+/);
        if (keyword) map.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
    }
    return map;
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function authenticate(conn, ext, user, password) {
    const mechanisms = new Set((ext.get('AUTH') ?? '').split(/\s+/).filter(Boolean));
    if (mechanisms.has('PLAIN') || !mechanisms.size) {
        await conn.command(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, [235], 'authentication (AUTH PLAIN)', 'EAUTH');
    } else if (mechanisms.has('LOGIN')) {
        await conn.command('AUTH LOGIN', [334], 'authentication (AUTH LOGIN)', 'EAUTH');
        await conn.command(b64(user), [334], 'authentication (AUTH LOGIN)', 'EAUTH');
        await conn.command(b64(password), [235], 'authentication (AUTH LOGIN)', 'EAUTH');
    } else {
        throw new SmtpError(`SMTP server offers no supported authentication mechanism (${[...mechanisms].join(', ')})`, { code: 'EAUTH' });
    }
}

/** CRLF line endings and RFC 5321 dot-stuffing; ends with the terminating "." line. */
export function dotStuff(raw) {
    return raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.';
}

/**
 * Submit one message.
 * @param {{host:string, port:number, secure:boolean, requireTls:boolean, user?:string, password?:string,
 *          timeoutMs?:number, rejectUnauthorized?:boolean, clientName?:string}} smtp
 * @param {{from:string, to:string[], raw:string}} message  envelope addresses (bare) + RFC 5322 message
 * @returns {Promise<{response:string}>} the server's reply to the message (usually a queue id)
 */
export async function sendMail(smtp, { from, to, raw }) {
    const { host, port, secure = false, requireTls = true, user = '', password = '', timeoutMs = 30000, rejectUnauthorized = true } = smtp;
    const clientName = smtp.clientName || os.hostname() || 'localhost';
    const conn = new Connection(timeoutMs);
    conn.use(await open({ host, port, secure, timeoutMs, rejectUnauthorized }));
    try {
        await conn.command(null, [220], 'greeting');
        let ext = extensions(await conn.command(`EHLO ${clientName}`, [250], 'EHLO'));
        let encrypted = secure;
        if (!encrypted && ext.has('STARTTLS')) {
            await conn.command('STARTTLS', [220], 'STARTTLS', 'ETLS');
            const plain = conn.socket;
            conn.detach();
            conn.use(await upgrade(plain, host, rejectUnauthorized));
            encrypted = true;
            ext = extensions(await conn.command(`EHLO ${clientName}`, [250], 'EHLO'));
        }
        if (!encrypted && requireTls) {
            throw new SmtpError(`SMTP server ${host}:${port} does not offer STARTTLS; not sending without TLS ` +
                '(use SMTP_SECURE=true for port 465, or SMTP_REQUIRE_TLS=false for a trusted local relay)', { code: 'ETLS' });
        }
        if (user) {
            if (!encrypted && !isLoopback(host)) {
                throw new SmtpError('Refusing to send SMTP credentials without TLS', { code: 'ETLS' });
            }
            await authenticate(conn, ext, user, password);
        }
        await conn.command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM', 'EENVELOPE');
        for (const recipient of to) await conn.command(`RCPT TO:<${recipient}>`, [250, 251], `RCPT TO <${recipient}>`, 'EENVELOPE');
        await conn.command('DATA', [354], 'DATA', 'EMESSAGE');
        const accepted = await conn.command(dotStuff(raw), [250], 'message transfer', 'EMESSAGE');
        await conn.command('QUIT', [221], 'QUIT').catch(() => {}); // the message is already accepted
        return { response: `${accepted.code} ${accepted.lines.join(' ')}`.slice(0, 255) };
    } finally {
        conn.close();
    }
}

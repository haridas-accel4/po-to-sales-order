import crypto from 'node:crypto';
import { addressOf } from './config.js';

/**
 * RFC 5322 / MIME message with a plain-text and an HTML alternative.
 * Bodies are base64 encoded (UTF-8, no line-length or dot issues); header values are
 * stripped of line breaks (no header injection from PO data) and RFC 2047 encoded
 * when they contain non-ASCII characters.
 */

const oneLine = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
const MESSAGE_ID = /^<[^<>\s]{1,498}>$/;

/** RFC 2047 encoded words (<= 75 chars each) for non-ASCII header text. */
export function encodeHeader(value) {
    const text = oneLine(value);
    if (/^[\x20-\x7e]*$/.test(text)) return text;
    const words = [];
    let chunk = '';
    for (const ch of text) {
        if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
            words.push(chunk);
            chunk = '';
        }
        chunk += ch;
    }
    if (chunk) words.push(chunk);
    return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** "Name <addr>" with an encoded/quoted display name, or the bare address. */
function formatAddress(value) {
    const address = addressOf(value);
    const name = oneLine(String(value).replace(/<[^<>]*>\s*$/, '')).replace(/^"|"$/g, '');
    if (!name || name === address) return address;
    return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}" <${address}>` : `${encodeHeader(name)} <${address}>`;
}

const base64Lines = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

/**
 * `inReplyTo` (the Message-ID of the e-mail answered) makes the message a reply in that
 * thread; `replyTo` directs answers to another mailbox (e.g. the order desk).
 *
 * @param {{from:string, to:string[], subject:string, text:string, html:string, date?:Date, replyTo?:string|null, inReplyTo?:string|null}} mail
 * @returns {{raw:string, messageId:string, envelope:{from:string, to:string[]}}}
 */
export function buildMessage({ from, to, subject, text, html, date = new Date(), replyTo = null, inReplyTo = null }) {
    const sender = addressOf(from);
    const recipients = to.map(addressOf);
    if (!sender || recipients.some((r) => !r)) throw new Error('Invalid sender or recipient address');
    if (replyTo && !addressOf(replyTo)) throw new Error('Invalid reply-to address');
    const parent = inReplyTo && MESSAGE_ID.test(oneLine(inReplyTo)) ? oneLine(inReplyTo) : null;
    const messageId = `<${crypto.randomUUID()}@${sender.split('@')[1]}>`;
    const boundary = `=_po2so_${crypto.randomUUID()}`;
    const raw = [
        `From: ${formatAddress(from)}`,
        `To: ${recipients.join(', ')}`,
        ...(replyTo ? [`Reply-To: ${formatAddress(replyTo)}`] : []),
        `Subject: ${encodeHeader(subject)}`,
        `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: ${messageId}`,
        ...(parent ? [`In-Reply-To: ${parent}`, `References: ${parent}`] : []),
        'MIME-Version: 1.0',
        'Auto-Submitted: auto-generated',
        'X-Auto-Response-Suppress: All',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(text),
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(html),
        `--${boundary}--`,
        '',
    ].join('\r\n');
    return { raw, messageId, envelope: { from: sender, to: recipients } };
}

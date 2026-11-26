/**
 * Pure helpers that decide whether a Gmail message is a purchase-order mail and which
 * attachments go into the intake pipeline. No I/O, no Gmail client - unit-tested directly.
 */

const BACKSLASH = String.fromCharCode(92);
const REGEX_SPECIAL = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', BACKSLASH, '/', '-']);
const MAX_TEXT = 200_000; // characters of subject + body that are searched

const escapeRegex = (s) => [...s].map((ch) => (REGEX_SPECIAL.has(ch) ? BACKSLASH + ch : ch)).join('');

/**
 * Compile keyword definitions into matchers.
 * A keyword matches as a whole word (or phrase): not preceded by a letter/digit and not
 * followed by a letter, so 'PO' matches "PO", "po#4711", "PO-2027-1", "PO4711" and "POs" but not
 * "POST", "report" or "photo". Matching is case-insensitive unless { caseSensitive: true }.
 * @param {Array<string|{term:string, caseSensitive?:boolean}>} keywords
 */
export function compileKeywords(keywords) {
    return (keywords ?? [])
        .map((k) => (typeof k === 'string' ? { term: k } : k))
        .filter((k) => k?.term && String(k.term).trim())
        .map((k) => {
            const term = String(k.term).trim();
            const body = term.split(/\s+/).map(escapeRegex).join('\\s+');
            const flags = k.caseSensitive ? 'u' : 'iu';
            return { term, regex: new RegExp(`(?<![\\p{L}\\p{N}])${body}s?(?!\\p{L})`, flags) };
        });
}

/** First keyword found in any of the texts, or null. */
export function findKeyword(texts, keywords) {
    const matchers = Array.isArray(keywords) && keywords[0]?.regex ? keywords : compileKeywords(keywords);
    const text = texts.filter(Boolean).join('\n').slice(0, MAX_TEXT);
    for (const m of matchers) {
        if (m.regex.test(text)) return m.term;
    }
    return null;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/**
 * Plain text from an HTML mail body for keyword matching only (never rendered).
 * Removes comments, script/style/head blocks and tags; decodes common entities.
 */
export function htmlToText(html) {
    return String(html ?? '')
        .slice(0, MAX_TEXT)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(Number(d)))
        .replace(/&([a-z]+|#39);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all)
        .replace(/\s+/g, ' ')
        .trim();
}

function safeCodePoint(n) {
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}

/** Decode Gmail's base64url body data. */
export function decodeBase64Url(data) {
    return Buffer.from(String(data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function header(headers, name) {
    const h = (headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value ?? '';
}

/** Lower-case extension without dot. */
export function extensionOf(fileName) {
    const m = /\.([^.]+)$/.exec(String(fileName ?? ''));
    return m ? m[1].toLowerCase() : '';
}

/**
 * Make an attachment name acceptable as a plain file name (no path separators, max 255
 * characters, extension kept). The file content is still validated by the pipeline.
 */
export function safeFileName(fileName) {
    let name = String(fileName ?? '').replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
    if (name.length > 255) {
        const ext = extensionOf(name);
        name = name.slice(0, 255 - (ext.length + 1)) + (ext ? `.${ext}` : '');
    }
    return name;
}

/**
 * Flatten a Gmail message (users.messages.get, format=full) into what the intake needs.
 * @returns {{id, threadId, sender, subject, receivedAt, plainText, htmlText, attachments: Array}}
 */
export function parseMessage(message) {
    const payload = message?.payload ?? {};
    const plain = [];
    const html = [];
    const attachments = [];

    const walk = (part, index) => {
        if (!part) return;
        const mimeType = String(part.mimeType ?? '').toLowerCase();
        const fileName = part.filename ?? '';
        const disposition = header(part.headers, 'Content-Disposition').toLowerCase();
        if (fileName || part.body?.attachmentId) {
            attachments.push({
                partId: String(part.partId ?? index ?? ''),
                fileName,
                mimeType: mimeType || 'application/octet-stream',
                size: Number(part.body?.size ?? 0),
                attachmentId: part.body?.attachmentId ?? null,
                data: part.body?.data ?? null,
                inline: disposition.startsWith('inline') || !!header(part.headers, 'Content-ID'),
            });
        } else if (mimeType === 'text/plain' && part.body?.data) {
            plain.push(decodeBase64Url(part.body.data).toString('utf8'));
        } else if (mimeType === 'text/html' && part.body?.data) {
            html.push(decodeBase64Url(part.body.data).toString('utf8'));
        }
        (part.parts ?? []).forEach((p, i) => walk(p, `${index}.${i}`));
    };
    walk(payload, '0');

    const internal = Number(message?.internalDate);
    return {
        id: message?.id,
        threadId: message?.threadId ?? null,
        sender: header(payload.headers, 'From').slice(0, 320),
        subject: header(payload.headers, 'Subject').slice(0, 500),
        receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null,
        plainText: plain.join('\n'),
        htmlText: htmlToText(html.join('\n')),
        attachments,
    };
}

/**
 * Split attachments into those handed to the pipeline and those ignored.
 * Only the configured extensions are supported; inline images and other files are ignored.
 * (The pipeline validates the actual file content - names and MIME types are not trusted.)
 */
export function selectAttachments(attachments, extensions) {
    const allowed = new Set((extensions ?? []).map((e) => String(e).toLowerCase().replace(/^\./, '')));
    const supported = [];
    const ignored = [];
    for (const a of attachments ?? []) {
        const ext = extensionOf(a.fileName);
        if (!a.fileName) ignored.push({ ...a, reason: 'no file name' });
        else if (!allowed.has(ext)) ignored.push({ ...a, reason: a.inline ? 'inline content' : `unsupported type .${ext || '?'}` });
        else if (!a.attachmentId && !a.data) ignored.push({ ...a, reason: 'no content' });
        else supported.push(a);
    }
    return { supported, ignored };
}

/**
 * Decide whether a parsed message is processed.
 * @returns {{process:boolean, keyword:string|null, reason:string|null, supported:Array, ignored:Array}}
 */
export function classifyMessage(parsed, { keywords, extensions }) {
    const keyword = findKeyword([parsed.subject, parsed.plainText, parsed.htmlText], keywords);
    const { supported, ignored } = selectAttachments(parsed.attachments, extensions);
    if (!keyword) return { process: false, keyword: null, reason: 'No purchase-order keyword in subject or body', supported, ignored };
    if (!supported.length) return { process: false, keyword, reason: 'No supported attachment (.pdf, .xlsx, .csv)', supported, ignored };
    return { process: true, keyword, reason: null, supported, ignored };
}

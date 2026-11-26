/**
 * In-memory stand-in for the Gmail API (same interface as srv/lib/gmail/gmail-client.js).
 * Messages are built like Gmail's users.messages.get(format=full) responses.
 * Failures can be queued per call type to simulate network / API errors.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function gmailError(status, message = `HTTP ${status}`) {
    return Object.assign(new Error(message), { response: { status, data: { error: { message } } } });
}

export function createFakeGmail({ emailAddress = 'po-inbox@example.com' } = {}) {
    const messages = new Map();      // id -> { message, internalDate }
    const attachmentData = new Map(); // attachmentId -> Buffer
    const calls = { list: 0, get: 0, attachment: 0, queries: [] };
    const failures = { list: [], get: new Map(), attachment: new Map() };
    let seq = 0;
    const tag = Math.random().toString(36).slice(2, 8); // message ids unique across fake instances
    let listDelayMs = 0;

    /**
     * @param {{id?, subject?, from?, text?, html?, receivedAt?:number,
     *          attachments?: Array<{fileName, mimeType, content:Buffer|string, inline?:boolean}>}} m
     */
    function addMessage(m) {
        const id = m.id ?? `msg${tag}${++seq}`;
        const internalDate = m.receivedAt ?? Date.now();
        const bodyParts = [];
        if (m.text !== undefined) bodyParts.push({ partId: '0.0', mimeType: 'text/plain', filename: '', headers: [], body: { size: m.text.length, data: b64url(m.text) } });
        if (m.html !== undefined) bodyParts.push({ partId: '0.1', mimeType: 'text/html', filename: '', headers: [], body: { size: m.html.length, data: b64url(m.html) } });
        const parts = [{ partId: '0', mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: bodyParts }];
        (m.attachments ?? []).forEach((a, i) => {
            const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content, 'utf8');
            const attachmentId = `att-${id}-${i}-${Math.random().toString(36).slice(2)}`;
            attachmentData.set(attachmentId, content);
            const headers = [{ name: 'Content-Disposition', value: `${a.inline ? 'inline' : 'attachment'}; filename="${a.fileName}"` }];
            if (a.inline) headers.push({ name: 'Content-ID', value: `<img${i}>` });
            parts.push({ partId: String(i + 1), mimeType: a.mimeType, filename: a.fileName, headers, body: { size: content.length, attachmentId } });
        });
        messages.set(id, {
            internalDate,
            message: {
                id,
                threadId: m.threadId ?? `thread-${id}`,
                internalDate: String(internalDate),
                payload: {
                    partId: '', mimeType: 'multipart/mixed', filename: '', body: { size: 0 }, parts,
                    headers: [
                        { name: 'From', value: m.from ?? 'Buyer <buyer@customer.example>' },
                        { name: 'Subject', value: m.subject ?? '' },
                    ],
                },
            },
        });
        return id;
    }

    const takeFailure = (map, key) => {
        const queue = map.get(key);
        if (queue?.length) {
            const f = queue.shift();
            throw typeof f === 'function' ? f() : f;
        }
    };

    const client = {
        async getProfile() {
            return { emailAddress };
        },
        async listMessageIds(q, pageToken) {
            calls.list++;
            calls.queries.push(q);
            if (listDelayMs) await new Promise((r) => setTimeout(r, listDelayMs));
            if (failures.list.length) throw failures.list.shift();
            const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
            const ids = [...messages.entries()]
                .filter(([, m]) => m.internalDate > after)
                .sort((a, b) => b[1].internalDate - a[1].internalDate)
                .map(([id]) => id);
            // two pages to exercise paging
            const start = pageToken ? Number(pageToken) : 0;
            const page = ids.slice(start, start + 2);
            return { ids: page, nextPageToken: start + 2 < ids.length ? String(start + 2) : null };
        },
        async getMessage(id) {
            calls.get++;
            takeFailure(failures.get, id);
            const m = messages.get(id);
            if (!m) throw gmailError(404, 'Not Found');
            return structuredClone(m.message);
        },
        async getAttachment(messageId, attachmentId) {
            calls.attachment++;
            // most specific queued failure first (single attachment, then whole message)
            const prefixes = [...failures.attachment.keys()]
                .filter((p) => attachmentId.startsWith(p) && failures.attachment.get(p).length)
                .sort((a, b) => b.length - a.length);
            if (prefixes.length) takeFailure(failures.attachment, prefixes[0]);
            void messageId;
            const data = attachmentData.get(attachmentId);
            if (!data) throw gmailError(404, 'Attachment not found');
            return Buffer.from(data);
        },
    };

    return {
        client,
        calls,
        addMessage,
        setListDelay: (ms) => { listDelayMs = ms; },
        /** Queue errors: failList(err...), failGet(id, err...), failAttachment(messageId, err...) */
        failList: (...errs) => failures.list.push(...errs),
        failGet: (id, ...errs) => failures.get.set(id, [...(failures.get.get(id) ?? []), ...errs]),
        failAttachment: (messageId, ...errs) => {
            const key = `att-${messageId}-`;
            failures.attachment.set(key, [...(failures.attachment.get(key) ?? []), ...errs]);
        },
        /** Fail a single attachment (by message id and 0-based attachment index) */
        failAttachmentAt: (messageId, index, ...errs) => {
            const key = `att-${messageId}-${index}-`;
            failures.attachment.set(key, [...(failures.attachment.get(key) ?? []), ...errs]);
        },
    };
}

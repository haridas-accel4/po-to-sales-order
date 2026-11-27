import cds from '@sap/cds';
import { getConfig } from '../config.js';
import { FileValidationError } from '../errors.js';
import { ingestDocument } from '../pipeline.js';
import { classifyMessage, compileKeywords, decodeBase64Url, parseMessage, safeFileName } from './email-filter.js';
import { isAuthError, safeErrorMessage, withRetry } from './retry.js';

/**
 * Gmail -> intake pipeline.
 *
 * Every supported attachment of a matching message is handed to the SAME function the
 * upload action uses (pipeline.ingestDocument, source 'EMAIL'): file validation, original
 * file storage, extraction, mapping, validation and duplicate checks are not duplicated here.
 *
 * Each attachment runs in its own transaction together with its EmailAttachments record,
 * so an attachment either produced exactly one InboundOrder and is marked PROCESSED, or
 * nothing was stored. The unique constraint (mailbox, message, part) rejects a second
 * InboundOrder for the same attachment even under concurrent polls.
 *
 * All functions here open their own transactions: call them outside of a request
 * transaction (the poller runs them in a detached context).
 */

const LOG = cds.log('gmail');
const T = () => cds.entities('po2so');
export const SYNC_ID = 'gmail';
const OPEN_MESSAGE = ['RETRY', 'PROCESSING'];
const DONE_ATTACHMENT = ['PROCESSED', 'REJECTED'];

export class GmailAuthError extends Error {
    constructor(cause) {
        super(`Gmail authorization is no longer valid (${safeErrorMessage(cause)}). Disconnect and connect Gmail again.`);
        this.name = 'GmailAuthError';
        this.code = 'GMAIL_AUTH';
    }
}

// ---------------------------------------------------------------- sync state

export async function readSyncState() {
    return (await SELECT.one.from(T().GmailSyncState, SYNC_ID)) ?? { ID: SYNC_ID };
}

export async function writeSyncState(data) {
    const { GmailSyncState } = T();
    const exists = await SELECT.one.from(GmailSyncState, SYNC_ID).columns('ID');
    if (exists) await UPDATE(GmailSyncState, SYNC_ID).with(data);
    else await INSERT.into(GmailSyncState).entries({ ID: SYNC_ID, ...data });
}

/** Gmail search for candidate messages since a point in time (keywords are checked locally). */
export function buildQuery(sinceMs, extensions) {
    const names = extensions.map((e) => `filename:${e}`).join(' OR ');
    return `after:${Math.floor(sinceMs / 1000)} has:attachment -in:drafts {${names}}`;
}

// ---------------------------------------------------------------- one message

async function saveMessage(existing, data) {
    const { EmailMessages } = T();
    if (existing?.ID) {
        await UPDATE(EmailMessages, existing.ID).with(data);
        return existing.ID;
    }
    const ID = cds.utils.uuid();
    await INSERT.into(EmailMessages).entries({ ID, ...data });
    return ID;
}

async function saveAttachment(existing, data) {
    const { EmailAttachments } = T();
    if (existing?.ID) await UPDATE(EmailAttachments, existing.ID).with(data);
    else await INSERT.into(EmailAttachments).entries(data);
}

const findMessage = (mailbox, gmailMessageId) =>
    cds.tx(() => SELECT.one.from(T().EmailMessages).where({ mailbox, gmailMessageId }));

/**
 * Process one Gmail message. Safe to call repeatedly: finished messages and attachments
 * are skipped, failed attachments are retried until maxAttempts.
 * @returns {Promise<{outcome:'known'|'ignored'|'completed'|'retry'|'failed', processed:number, rejected:number, failed:number, error?:string}>}
 */
export async function processMessage({ client, mailbox, gmailMessageId, config }) {
    const result = { outcome: 'known', processed: 0, rejected: 0, failed: 0 };
    const existing = await findMessage(mailbox, gmailMessageId);
    if (existing && !OPEN_MESSAGE.includes(existing.status)) return result;
    const attempts = (existing?.attempts ?? 0) + 1;
    const retry = { ...config.retry };

    let parsed;
    try {
        parsed = parseMessage(await withRetry(() => client.getMessage(gmailMessageId), retry));
    } catch (e) {
        if (isAuthError(e)) throw new GmailAuthError(e);
        const error = safeErrorMessage(e);
        const status = attempts >= config.maxAttempts ? 'FAILED' : 'RETRY';
        await cds.tx(() => saveMessage(existing, { mailbox, gmailMessageId, status, attempts, lastError: error }));
        LOG.warn(`Gmail message ${gmailMessageId} could not be read (attempt ${attempts}): ${error}`);
        return { ...result, outcome: status === 'FAILED' ? 'failed' : 'retry', error };
    }

    const header = {
        mailbox, gmailMessageId, threadId: parsed.threadId, rfcMessageId: parsed.rfcMessageId, sender: parsed.sender, subject: parsed.subject, receivedAt: parsed.receivedAt,
    };
    const decision = classifyMessage(parsed, { keywords: config.compiledKeywords, extensions: config.attachmentExtensions });
    if (!decision.process) {
        await cds.tx(() => saveMessage(existing, {
            ...header, status: 'IGNORED', matchedKeyword: decision.keyword, ignoreReason: decision.reason,
            supportedAttachments: decision.supported.length, attempts, lastError: null,
        }));
        return { ...result, outcome: 'ignored' };
    }

    let messageId;
    try {
        messageId = await cds.tx(() => saveMessage(existing, {
            ...header, status: 'PROCESSING', matchedKeyword: decision.keyword, ignoreReason: null,
            supportedAttachments: decision.supported.length, attempts,
        }));
    } catch (e) {
        if (/UNIQUE constraint/i.test(e.message)) return result; // another poller instance took it
        throw e;
    }

    const maxFileSize = getConfig().maxFileSize;
    let lastError = null;
    for (const att of decision.supported) {
        const done = await cds.tx(() => SELECT.one.from(T().EmailAttachments).where({ mailbox, gmailMessageId, partId: att.partId }));
        if (done && DONE_ATTACHMENT.includes(done.status)) continue;

        const fileName = safeFileName(att.fileName);
        const base = {
            message_ID: messageId, mailbox, gmailMessageId, partId: att.partId, fileName, mimeType: att.mimeType,
            size: att.size || null, attempts: (done?.attempts ?? 0) + 1,
        };
        try {
            if (att.size > maxFileSize) {
                throw new FileValidationError(`File is ${att.size} bytes; the maximum allowed size is ${maxFileSize} bytes.`, 'FILE_TOO_LARGE');
            }
            const buffer = att.data
                ? decodeBase64Url(att.data)
                : await withRetry(() => client.getAttachment(gmailMessageId, att.attachmentId), retry);

            // the same intake function as uploadPurchaseOrder; customer unknown -> review decides
            await cds.tx(async () => {
                const order = await ingestDocument({ source: 'EMAIL', fileName, mimeType: att.mimeType, buffer, customerId: null });
                await saveAttachment(done, {
                    ...base, size: buffer.length, status: 'PROCESSED', errorCode: null, errorMessage: null, inboundOrder_ID: order.ID,
                });
                LOG.info(`Gmail ${gmailMessageId} / ${fileName}: inbound order ${order.ID} (${order.status})`);
            });
            result.processed++;
        } catch (e) {
            if (isAuthError(e)) throw new GmailAuthError(e);
            const rejected = e instanceof FileValidationError;
            const message = rejected ? e.message : safeErrorMessage(e);
            await cds.tx(() => saveAttachment(done, {
                ...base, status: rejected ? 'REJECTED' : 'FAILED', errorCode: e.code && typeof e.code === 'string' ? e.code.slice(0, 40) : null,
                errorMessage: message.slice(0, 1000), inboundOrder_ID: null,
            }));
            if (rejected) result.rejected++;
            else {
                result.failed++;
                lastError = `${fileName}: ${message}`;
            }
            LOG.warn(`Gmail ${gmailMessageId} / ${fileName}: ${rejected ? 'rejected' : 'failed'} - ${message}`);
        }
    }

    // complete only when every supported attachment is processed or (permanently) rejected
    const rows = await cds.tx(() => SELECT.from(T().EmailAttachments).columns('partId', 'status').where({ mailbox, gmailMessageId }));
    const doneParts = new Set(rows.filter((r) => DONE_ATTACHMENT.includes(r.status)).map((r) => r.partId));
    const complete = decision.supported.every((a) => doneParts.has(a.partId));
    const status = complete ? 'COMPLETED' : (attempts >= config.maxAttempts ? 'FAILED' : 'RETRY');
    await cds.tx(() => saveMessage({ ID: messageId }, { status, lastError: complete ? null : lastError?.slice(0, 1000) }));
    return { ...result, outcome: complete ? 'completed' : status.toLowerCase(), error: lastError ?? undefined };
}

// ---------------------------------------------------------------- one poll

/**
 * One synchronisation run for a mailbox:
 *   1. retry messages left in RETRY / PROCESSING (e.g. transient error, restart mid-way)
 *   2. list messages received after (cursor - overlap) and process the unknown ones
 *   3. advance the cursor to the start of this run - only if the listing was complete
 *
 * @param {{client, mailbox:string, backfillDays?:number, now?:number, config}} options
 */
export async function syncMailbox({ client, mailbox, backfillDays = null, now = Date.now(), config }) {
    const cfg = { ...config, compiledKeywords: compileKeywords(config.keywords) };
    const summary = {
        startedAt: new Date(now).toISOString(), messagesChecked: 0, messagesIgnored: 0, messagesCompleted: 0, messagesRetry: 0, messagesFailed: 0,
        attachmentsProcessed: 0, attachmentsRejected: 0, attachmentsFailed: 0, complete: true, errors: [],
    };
    const tally = (r) => {
        if (r.outcome === 'known') return;
        summary.messagesChecked++;
        if (r.outcome === 'ignored') summary.messagesIgnored++;
        if (r.outcome === 'completed') summary.messagesCompleted++;
        if (r.outcome === 'retry') summary.messagesRetry++;
        if (r.outcome === 'failed') summary.messagesFailed++;
        summary.attachmentsProcessed += r.processed;
        summary.attachmentsRejected += r.rejected;
        summary.attachmentsFailed += r.failed;
        if (r.error) summary.errors.push(r.error);
    };
    const handled = new Set();

    // 1. retries (independent of the cursor window)
    const open = await cds.tx(() => SELECT.from(T().EmailMessages).columns('gmailMessageId')
        .where({ mailbox, status: { in: OPEN_MESSAGE } }).orderBy('createdAt'));
    for (const { gmailMessageId } of open) {
        handled.add(gmailMessageId);
        tally(await processMessage({ client, mailbox, gmailMessageId, config: cfg }));
    }

    // 2. new messages
    const state = await cds.tx(() => readSyncState());
    const base = backfillDays
        ? now - backfillDays * 24 * 3600 * 1000
        : (Date.parse(state.cursor ?? state.connectedAt ?? '') || now) - cfg.overlapMinutes * 60 * 1000;
    const query = buildQuery(base, cfg.attachmentExtensions);
    let fetched = 0;
    let pageToken;
    do {
        let page;
        try {
            page = await withRetry(() => client.listMessageIds(query, pageToken), cfg.retry);
        } catch (e) {
            if (isAuthError(e)) throw new GmailAuthError(e);
            throw e;
        }
        for (const id of page.ids) {
            if (handled.has(id)) continue;
            handled.add(id);
            const known = await findMessage(mailbox, id);
            if (known && !OPEN_MESSAGE.includes(known.status)) continue; // already handled - no API call
            if (fetched >= cfg.maxMessagesPerPoll) {
                summary.complete = false; // continue on the next poll, keep the cursor
                break;
            }
            fetched++;
            tally(await processMessage({ client, mailbox, gmailMessageId: id, config: cfg }));
        }
        pageToken = summary.complete ? page.nextPageToken : null;
    } while (pageToken);

    // 3. cursor: messages older than (cursor - overlap) are not listed again
    if (summary.complete) {
        const current = Date.parse(state.cursor ?? '') || 0;
        await cds.tx(() => writeSyncState({ cursor: new Date(Math.max(current, now)).toISOString() }));
    }
    return summary;
}

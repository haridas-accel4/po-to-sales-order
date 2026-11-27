import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { configProblems, getNotificationConfig } from './config.js';
import { composeFailureEmail } from './failure-email.js';
import { buildMessage } from './mime.js';
import { isTransientMailError, sendMail } from './smtp-client.js';

/**
 * Exception e-mail when SAP sales order creation fails (pipeline.postSalesOrder).
 *
 *   notifySalesOrderFailure()  called by the pipeline; never throws, never waits for SMTP
 *     -> after the caller's transaction committed (nothing is sent for a rolled-back failure)
 *     -> detached: own transactions, the order / HTTP response is never affected
 *   deliver()                  dedup claim (FailureNotifications.dedupKey) -> compose -> send
 *                              with retries -> SENT | SEND_FAILED
 *
 * The same failure of the same order (type + SAP messages) is e-mailed at most once;
 * a SEND_FAILED notification is sent again when that failure occurs the next time.
 */

const LOG = cds.log('notification');

/** Captured at module load: detached work never joins a request's transaction. */
const runDetached = AsyncLocalStorage.snapshot();

const inFlight = new Set();

const T = () => cds.entities('po2so');

/** Stable key of one failure: same order + type + SAP messages = same notification. */
export function dedupKeyOf({ orderId, failureType, messages = [] }) {
    const normalized = messages.map((m) => String(m ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return crypto.createHash('sha256').update(JSON.stringify([orderId, failureType, normalized])).digest('hex');
}

/**
 * Report a failed sales order creation. Safe to call from inside the pipeline:
 * returns immediately and never throws.
 *
 * @param {{orderId:string, failureType:'SAP_REJECTED'|'SAP_DUPLICATE'|'SAP_UNAVAILABLE', messages:string[], httpStatus?:number|null}} failure
 */
export function notifySalesOrderFailure({ orderId, failureType, messages = [], httpStatus = null }) {
    try {
        const config = getNotificationConfig();
        if (!config.enabled) return;
        if (failureType === 'SAP_UNAVAILABLE' && !config.notifyOnSapUnavailable) return;

        const failure = { orderId, failureType, messages: [...messages], httpStatus: httpStatus ?? null, failedAt: new Date().toISOString() };
        const start = () => track(runDetached(() => deliver(failure)), orderId);
        const ctx = cds.context;
        // only once the failure is committed; a rollback discards the notification
        if (ctx?.tx) ctx.on('succeeded', start);
        else start();
    } catch (e) {
        LOG.error(`Inbound order ${orderId}: failure notification could not be scheduled:`, e);
    }
}

function track(promise, orderId) {
    const p = Promise.resolve(promise)
        .catch((e) => LOG.error(`Inbound order ${orderId}: failure notification error:`, e))
        .finally(() => inFlight.delete(p));
    inFlight.add(p);
}

/** Resolves when all notifications scheduled so far are finished (tests, shutdown). */
export async function whenIdle() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** Error text for logs / the notification row: never credentials (the SMTP client omits them). */
const errorText = (e) => `${e?.message ?? e}`.slice(0, 1000);

/**
 * Claim, compose and send the e-mail for one failure.
 * @returns {Promise<'sent'|'send_failed'|'duplicate'|'not_configured'>}
 */
export async function deliver(failure) {
    const config = getNotificationConfig();
    const problems = configProblems(config);
    if (problems.length) {
        LOG.warn(`Inbound order ${failure.orderId}: sales order failure e-mail not sent - e-mail sending is not configured (${problems.join('; ')}).`);
        return 'not_configured';
    }

    const details = await cds.tx(() => loadDetails(failure.orderId));
    const dedupKey = dedupKeyOf(failure);
    const claim = await claimNotification(dedupKey, failure, details, config);
    if (!claim) {
        LOG.info(`Inbound order ${failure.orderId}: ${failure.failureType} already notified - duplicate e-mail suppressed.`);
        return 'duplicate';
    }

    const { FailureNotifications } = T();
    let attempts = claim.attempts ?? 0;
    try {
        const content = composeFailureEmail({ ...details, failure });
        const message = buildMessage({ from: config.from, to: config.recipients, ...content });
        const { response } = await withRetry(() => {
            attempts++;
            return sendMail({ ...config.smtp, timeoutMs: config.timeoutMs }, { ...message.envelope, raw: message.raw });
        }, config.retry, (e, delay) => LOG.warn(`Inbound order ${failure.orderId}: failure e-mail attempt ${attempts} failed (${errorText(e)}); retrying in ${delay} ms.`));

        await cds.tx(() => UPDATE(FailureNotifications, claim.ID).with({
            status: 'SENT', attempts, sentAt: new Date().toISOString(), smtpResponse: response, lastError: null,
        }));
        LOG.info(`Inbound order ${failure.orderId}: ${failure.failureType} e-mail sent to ${config.recipients.join(', ')}.`);
        return 'sent';
    } catch (e) {
        await cds.tx(() => UPDATE(FailureNotifications, claim.ID).with({ status: 'SEND_FAILED', attempts, lastError: errorText(e) }));
        LOG.error(`Inbound order ${failure.orderId}: failure e-mail could not be sent after ${attempts} attempt(s): ${errorText(e)}`);
        return 'send_failed';
    }
}

async function loadDetails(orderId) {
    const { InboundOrders, InboundItems, Customers, EmailAttachments, EmailMessages } = T();
    const order = await SELECT.one.from(InboundOrders, orderId);
    if (!order) throw new Error(`Inbound order ${orderId} not found`);
    const customer = order.customerId ? await SELECT.one.from(Customers).where({ customerId: order.customerId }) : null;
    const items = await SELECT.from(InboundItems).where({ parent_ID: orderId }).orderBy('lineNumber');
    const attachment = order.source === 'EMAIL'
        ? await SELECT.one.from(EmailAttachments).columns('message_ID').where({ inboundOrder_ID: orderId })
        : null;
    const email = attachment?.message_ID
        ? await SELECT.one.from(EmailMessages, attachment.message_ID).columns('sender', 'subject', 'receivedAt')
        : null;
    return { order, customer: customer ?? null, items, email: email ?? null };
}

const isUniqueViolation = (e) => /unique constraint|UNIQUE_CONSTRAINT|ENTITY_ALREADY_EXISTS/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);

/**
 * Reserve the notification for this failure.
 * New failure -> new PENDING row. Already SENT or being sent -> null (duplicate).
 * SEND_FAILED (or PENDING left behind by a stopped process) -> taken over atomically.
 */
async function claimNotification(dedupKey, failure, { order, customer }, config) {
    const { FailureNotifications } = T();
    const data = {
        failureType: failure.failureType,
        customerPoNumber: order.customerPoNumber,
        customerName: customer?.customerName ?? null,
        soldToParty: order.soldToParty ?? customer?.soldToParty ?? null,
        failureMessage: failure.messages.join('\n').slice(0, 1000) || null,
        failedAt: failure.failedAt,
        recipients: config.recipients.join(', ').slice(0, 1000),
        status: 'PENDING',
    };
    const ID = cds.utils.uuid();
    try {
        await cds.tx(() => INSERT.into(FailureNotifications).entries({ ID, dedupKey, inboundOrder_ID: order.ID, attempts: 0, ...data }));
        return { ID, attempts: 0 };
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
    }

    const staleBefore = new Date(Date.now() - config.stalePendingMinutes * 60_000).toISOString();
    return cds.tx(async () => {
        const existing = await SELECT.one.from(FailureNotifications).columns('ID', 'status', 'attempts').where({ dedupKey });
        if (!existing || existing.status === 'SENT') return null;
        const where = existing.status === 'PENDING'
            ? { ID: existing.ID, status: 'PENDING', modifiedAt: { '<': staleBefore } }
            : { ID: existing.ID, status: existing.status };
        const updated = await UPDATE(FailureNotifications).set(data).where(where);
        return updated ? existing : null;
    });
}

/** Retry temporary SMTP / network errors with exponential backoff. */
async function withRetry(fn, { retries, baseDelayMs }, onRetry) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt >= retries || !isTransientMailError(e)) throw e;
            const delay = baseDelayMs * 2 ** attempt;
            onRetry?.(e, delay);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

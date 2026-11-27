import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { addressOf, configProblems, getNotificationConfig } from './config.js';
import { composeFailureEmail } from './failure-email.js';
import { composeConfirmationEmail, composeCreatedEmail, composeUnderReviewEmail } from './status-email.js';
import { buildMessage } from './mime.js';
import { isTransientMailError, sendMail } from './smtp-client.js';

/**
 * Status e-mails about inbound orders, so that nobody has to watch the app to learn what
 * happened to a PO.
 *
 *   event                         INTERNAL (SO_FAILURE_EMAIL_TO)   CUSTOMER (sender of an e-mailed PO)
 *   SAP_REJECTED / SAP_DUPLICATE  exception e-mail (any channel)   "under review"
 *   SAP_UNAVAILABLE               exception e-mail (configurable)  "under review"
 *   NEEDS_REVIEW / DUPLICATE_PO   exception e-mail (e-mailed POs)  "under review"
 *   EXTRACTION_FAILED             exception e-mail (e-mailed POs)  - (the file may not be a PO)
 *   SO_CREATED                    "created" (e-mailed POs)         order confirmation
 *
 * The customer gets "under review" at most once per e-mail, and the confirmation once per
 * order; both are replies in the thread of the customer's e-mail.
 *
 *   notifyOrderEvent()  called by the pipeline; never throws, never waits for SMTP
 *     -> after the caller's transaction committed (nothing is sent for a rolled-back event)
 *     -> detached: own transactions, the order / HTTP response is never affected
 *   deliverEvent()      plan the e-mails -> per e-mail: dedup claim (FailureNotifications.dedupKey)
 *                       -> compose -> send with retries -> SENT | SEND_FAILED
 *
 * The same e-mail is sent at most once; a SEND_FAILED one is sent again when its event
 * occurs the next time.
 */

const LOG = cds.log('notification');

/** Captured at module load: detached work never joins a request's transaction. */
const runDetached = AsyncLocalStorage.snapshot();

const inFlight = new Set();

const T = () => cds.entities('po2so');

const SAP_EXCEPTIONS = ['SAP_REJECTED', 'SAP_DUPLICATE', 'SAP_UNAVAILABLE'];
/** Exceptions at intake: only e-mailed for e-mailed POs (an uploader sees the result at once). */
const INTAKE_EXCEPTIONS = ['EXTRACTION_FAILED', 'NEEDS_REVIEW', 'DUPLICATE_PO'];
export const EXCEPTION_TYPES = [...SAP_EXCEPTIONS, ...INTAKE_EXCEPTIONS];
export const ORDER_EVENTS = [...EXCEPTION_TYPES, 'SO_CREATED'];

/** Stable key of one e-mail: same subject (order or e-mail) + type + messages = same notification. */
export function dedupKeyOf({ orderId, failureType, messages = [] }) {
    const normalized = messages.map((m) => String(m ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return crypto.createHash('sha256').update(JSON.stringify([orderId, failureType, normalized])).digest('hex');
}

/**
 * Report an event of an inbound order. Safe to call from inside the pipeline:
 * returns immediately and never throws.
 *
 * @param {{orderId:string, type:string, messages?:string[], httpStatus?:number|null}} event  type: one of ORDER_EVENTS
 */
export function notifyOrderEvent({ orderId, type, messages = [], httpStatus = null }) {
    try {
        const config = getNotificationConfig();
        if (!config.enabled) return;
        if (!ORDER_EVENTS.includes(type)) throw new Error(`Unknown notification event ${type}`);

        const event = { orderId, type, messages: [...messages], httpStatus: httpStatus ?? null, at: new Date().toISOString() };
        const start = () => track(runDetached(() => deliverEvent(event)), orderId);
        const ctx = cds.context;
        // only once the event is committed; a rollback discards the notification
        if (ctx?.tx) ctx.on('succeeded', start);
        else start();
    } catch (e) {
        LOG.error(`Inbound order ${orderId}: notification could not be scheduled:`, e);
    }
}

/** Failed sales order creation (kept for callers of the first version). */
export function notifySalesOrderFailure({ orderId, failureType, messages = [], httpStatus = null }) {
    notifyOrderEvent({ orderId, type: failureType, messages, httpStatus });
}

function track(promise, orderId) {
    const p = Promise.resolve(promise)
        .catch((e) => LOG.error(`Inbound order ${orderId}: notification error:`, e))
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
 * Customer address for an e-mailed PO: the sender, unless customer e-mails are off or the
 * sender is this application itself (the polled mailbox or the sending address).
 * @returns {{address:string|null, reason:string|null}}
 */
export function customerRecipient({ order, email }, config) {
    if (order.source !== 'EMAIL') return { address: null, reason: null };
    if (!config.customerEmails) return { address: null, reason: 'customer e-mails are switched off' };
    const address = addressOf(email?.sender);
    if (!address) return { address: null, reason: 'no valid sender address' };
    const own = [email?.mailbox, addressOf(config.from)].filter(Boolean).map((a) => a.toLowerCase());
    if (own.includes(address.toLowerCase())) return { address: null, reason: 'the PO was sent from this application\'s own mailbox' };
    return { address, reason: null };
}

/**
 * Which e-mails an event causes. Pure: no I/O.
 * @returns {Array<{type:string, audience:'INTERNAL'|'CUSTOMER', recipients:string[], dedupKey:string}>}
 */
export function planEmails(event, details, config) {
    const { order, email } = details;
    const fromEmail = order.source === 'EMAIL';
    const plans = [];
    const customer = customerRecipient(details, config).address;

    if (customer && EXCEPTION_TYPES.includes(event.type) && event.type !== 'EXTRACTION_FAILED') {
        plans.push({ type: 'UNDER_REVIEW', audience: 'CUSTOMER', recipients: [customer],
            dedupKey: dedupKeyOf({ orderId: email.ID, failureType: 'UNDER_REVIEW' }) });
    }
    if (customer && event.type === 'SO_CREATED') {
        plans.push({ type: 'ORDER_CONFIRMED', audience: 'CUSTOMER', recipients: [customer],
            dedupKey: dedupKeyOf({ orderId: order.ID, failureType: 'ORDER_CONFIRMED' }) });
    }

    const internalException = SAP_EXCEPTIONS.includes(event.type) || (INTAKE_EXCEPTIONS.includes(event.type) && fromEmail);
    if (internalException && !(event.type === 'SAP_UNAVAILABLE' && !config.notifyOnSapUnavailable)) {
        plans.push({ type: event.type, audience: 'INTERNAL', recipients: config.recipients,
            dedupKey: dedupKeyOf({ orderId: order.ID, failureType: event.type, messages: event.messages }) });
    }
    if (event.type === 'SO_CREATED' && fromEmail && config.notifyOnCreated && config.createdRecipients.length) {
        plans.push({ type: 'SO_CREATED', audience: 'INTERNAL', recipients: config.createdRecipients,
            dedupKey: dedupKeyOf({ orderId: order.ID, failureType: 'SO_CREATED' }) });
    }
    return plans;
}

/** One line for the internal e-mail: what the customer was (or was not) told. */
function customerNotice(event, details, config, plans, results) {
    if (details.order.source !== 'EMAIL') return null;
    const plan = plans.find((p) => p.audience === 'CUSTOMER');
    if (!plan) {
        if (event.type === 'EXTRACTION_FAILED') return 'Not contacted - the file may not be a purchase order';
        return `Not contacted - ${customerRecipient(details, config).reason ?? 'not applicable'}`;
    }
    const what = plan.type === 'ORDER_CONFIRMED' ? 'Order confirmation' : '"Under review" e-mail';
    const to = plan.recipients.join(', ');
    switch (results[plan.type]) {
        case 'sent': return `${what} sent to ${to}`;
        case 'duplicate': return `${what} already sent to ${to} earlier`;
        default: return `${what} to ${to} could not be sent (see the log)`;
    }
}

/**
 * Plan, claim, compose and send the e-mails of one event (customer first, so the internal
 * e-mail can say whether the customer was told).
 * @returns {Promise<Record<string, 'sent'|'send_failed'|'duplicate'>|'not_configured'>}
 */
export async function deliverEvent(event) {
    const config = getNotificationConfig();
    const problems = configProblems(config);
    if (problems.length) {
        LOG.warn(`Inbound order ${event.orderId}: ${event.type} e-mail not sent - e-mail sending is not configured (${problems.join('; ')}).`);
        return 'not_configured';
    }

    const details = await cds.tx(() => loadDetails(event.orderId));
    const plans = planEmails(event, details, config);
    const results = {};
    for (const plan of plans.filter((p) => p.audience === 'CUSTOMER')) {
        results[plan.type] = await deliverOne(plan, event, details, config);
    }
    const notice = customerNotice(event, details, config, plans, results);
    for (const plan of plans.filter((p) => p.audience === 'INTERNAL')) {
        results[plan.type] = await deliverOne(plan, event, details, config, notice);
    }
    return results;
}

function compose(plan, event, details, config, notice) {
    switch (plan.type) {
        case 'UNDER_REVIEW': return composeUnderReviewEmail({ ...details, signature: config.customerSignature });
        case 'ORDER_CONFIRMED': return composeConfirmationEmail({ ...details, signature: config.customerSignature });
        case 'SO_CREATED': return composeCreatedEmail({ ...details, createdAt: event.at, customerNotice: notice });
        default: return composeFailureEmail({
            ...details, customerNotice: notice,
            failure: { failureType: plan.type, messages: event.messages, httpStatus: event.httpStatus, failedAt: event.at },
        });
    }
}

/** @returns {Promise<'sent'|'send_failed'|'duplicate'>} */
async function deliverOne(plan, event, details, config, notice = null) {
    const label = `Inbound order ${event.orderId}: ${plan.type} e-mail`;
    const claim = await claimNotification(plan, event, details);
    if (!claim) {
        LOG.info(`${label} already sent - duplicate e-mail suppressed.`);
        return 'duplicate';
    }

    const { FailureNotifications } = T();
    let attempts = claim.attempts ?? 0;
    try {
        const content = compose(plan, event, details, config, notice);
        const toCustomer = plan.audience === 'CUSTOMER';
        const message = buildMessage({
            from: config.from, to: plan.recipients, ...content,
            replyTo: toCustomer ? config.customerReplyTo : null,
            inReplyTo: toCustomer ? details.email?.rfcMessageId : null,
        });
        const { response } = await withRetry(() => {
            attempts++;
            return sendMail({ ...config.smtp, timeoutMs: config.timeoutMs }, { ...message.envelope, raw: message.raw });
        }, config.retry, (e, delay) => LOG.warn(`${label} attempt ${attempts} failed (${errorText(e)}); retrying in ${delay} ms.`));

        await cds.tx(() => UPDATE(FailureNotifications, claim.ID).with({
            status: 'SENT', attempts, sentAt: new Date().toISOString(), smtpResponse: response, lastError: null,
        }));
        LOG.info(`${label} sent to ${plan.recipients.join(', ')}.`);
        return 'sent';
    } catch (e) {
        await cds.tx(() => UPDATE(FailureNotifications, claim.ID).with({ status: 'SEND_FAILED', attempts, lastError: errorText(e) }));
        LOG.error(`${label} could not be sent after ${attempts} attempt(s): ${errorText(e)}`);
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
        ? await SELECT.one.from(EmailMessages, attachment.message_ID).columns('ID', 'mailbox', 'sender', 'subject', 'receivedAt', 'rfcMessageId')
        : null;
    return { order, customer: customer ?? null, items, email: email ?? null };
}

const isUniqueViolation = (e) => /unique constraint|UNIQUE_CONSTRAINT|ENTITY_ALREADY_EXISTS/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);

/**
 * Reserve one e-mail.
 * New -> new PENDING row. Already SENT or being sent -> null (duplicate).
 * SEND_FAILED (or PENDING left behind by a stopped process) -> taken over atomically.
 */
async function claimNotification(plan, event, { order, customer }) {
    const { FailureNotifications } = T();
    const config = getNotificationConfig();
    const data = {
        failureType: plan.type,
        audience: plan.audience,
        customerPoNumber: order.customerPoNumber,
        customerName: customer?.customerName ?? null,
        soldToParty: order.soldToParty ?? customer?.soldToParty ?? null,
        failureMessage: event.messages.join('\n').slice(0, 1000) || null,
        failedAt: event.at,
        recipients: plan.recipients.join(', ').slice(0, 1000),
        status: 'PENDING',
    };
    const ID = cds.utils.uuid();
    try {
        await cds.tx(() => INSERT.into(FailureNotifications).entries({ ID, dedupKey: plan.dedupKey, inboundOrder_ID: order.ID, attempts: 0, ...data }));
        return { ID, attempts: 0 };
    } catch (e) {
        if (!isUniqueViolation(e)) throw e;
    }

    const staleBefore = new Date(Date.now() - config.stalePendingMinutes * 60_000).toISOString();
    return cds.tx(async () => {
        const existing = await SELECT.one.from(FailureNotifications).columns('ID', 'status', 'attempts').where({ dedupKey: plan.dedupKey });
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

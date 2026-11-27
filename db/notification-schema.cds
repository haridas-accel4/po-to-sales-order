namespace po2so;

using { cuid, managed } from '@sap/cds/common';
using { po2so.InboundOrders } from './inbound-schema';

/**
 * Status e-mails about inbound orders (see srv/lib/notifications).
 *
 *   INTERNAL  exception e-mails: every failed SAP creation and, for e-mailed POs, also
 *             extraction, validation and duplicate failures at intake; for e-mailed POs
 *             also "sales order created"
 *   CUSTOMER  for e-mailed POs only, a reply in the sender's thread: "under review" (once
 *             per e-mail) and the order confirmation once the sales order was created
 *
 * One row per e-mail. The unique dedupKey guarantees that the same e-mail is sent at most
 * once, also across resubmits, restarts and concurrent requests. A failed send stays
 * SEND_FAILED and is sent again when the same event occurs the next time.
 *
 * Additive only: a new table, no change to existing ones. No secrets are stored.
 */

type FailureNotificationStatus : String(20) enum {
    PENDING;     // claimed, being sent
    SENT;        // accepted by the SMTP server
    SEND_FAILED; // could not be sent (after retries); see lastError
}

type SalesOrderFailureType : String(20) enum {
    // internal: exceptions
    SAP_REJECTED;      // SAP rejected the sales order data -> order FAILED
    SAP_DUPLICATE;     // a sales order for this customer PO already exists in SAP -> order FAILED
    SAP_UNAVAILABLE;   // SAP Sales Order API not reachable / not authorized -> order stays VALIDATED
    EXTRACTION_FAILED; // e-mailed PO could not be read -> order FAILED
    NEEDS_REVIEW;      // e-mailed PO has missing / unmapped data -> order NEEDS_REVIEW
    DUPLICATE_PO;      // e-mailed PO already exists in the app -> order FAILED
    // internal: information
    SO_CREATED;        // e-mailed PO: sales order created in SAP
    // customer (sender of the e-mailed PO)
    UNDER_REVIEW;      // the PO was received and is being reviewed
    ORDER_CONFIRMED;   // the sales order was created
}

type NotificationAudience : String(10) enum {
    INTERNAL;
    CUSTOMER;
}

@assert.unique.dedupKey: [dedupKey]
entity FailureNotifications : cuid, managed {
    /** sha256 of order (or e-mail) ID, type and messages */
    dedupKey         : String(64) not null;
    inboundOrder     : Association to InboundOrders;
    /** What the e-mail is about (historic name: also holds the non-failure types) */
    failureType      : SalesOrderFailureType;
    audience         : NotificationAudience default 'INTERNAL';
    customerPoNumber : String(35);
    customerName     : String(100);
    soldToParty      : String(10);
    failureMessage   : String(1000);
    /** When the event happened (latest occurrence) */
    failedAt         : Timestamp;
    recipients       : String(1000);
    status           : FailureNotificationStatus;
    /** SMTP delivery attempts, including retries */
    attempts         : Integer default 0;
    sentAt           : Timestamp;
    smtpResponse     : String(255);
    lastError        : String(1000);
}

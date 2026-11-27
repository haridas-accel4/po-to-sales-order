namespace po2so;

using { cuid, managed } from '@sap/cds/common';
using { po2so.InboundOrders } from './inbound-schema';

/**
 * Exception e-mails for failed SAP sales order creation (see srv/lib/notifications).
 *
 * One row per distinct failure of an inbound order. The unique dedupKey (order + failure
 * type + SAP messages) guarantees that the same failure is e-mailed at most once, also
 * across resubmits, restarts and concurrent requests. A failed send stays SEND_FAILED and
 * is sent again when the same failure occurs the next time.
 *
 * Additive only: a new table, no change to existing ones. No secrets are stored.
 */

type FailureNotificationStatus : String(20) enum {
    PENDING;     // claimed, being sent
    SENT;        // accepted by the SMTP server
    SEND_FAILED; // could not be sent (after retries); see lastError
}

type SalesOrderFailureType : String(20) enum {
    SAP_REJECTED;    // SAP rejected the sales order data -> order FAILED
    SAP_DUPLICATE;   // a sales order for this customer PO already exists in SAP -> order FAILED
    SAP_UNAVAILABLE; // SAP Sales Order API not reachable / not authorized -> order stays VALIDATED
}

@assert.unique.dedupKey: [dedupKey]
entity FailureNotifications : cuid, managed {
    /** sha256 of order ID, failure type and SAP messages */
    dedupKey         : String(64) not null;
    inboundOrder     : Association to InboundOrders;
    failureType      : SalesOrderFailureType;
    customerPoNumber : String(35);
    customerName     : String(100);
    soldToParty      : String(10);
    failureMessage   : String(1000);
    /** When the sales order creation failed (latest occurrence) */
    failedAt         : Timestamp;
    recipients       : String(1000);
    status           : FailureNotificationStatus;
    /** SMTP delivery attempts, including retries */
    attempts         : Integer default 0;
    sentAt           : Timestamp;
    smtpResponse     : String(255);
    lastError        : String(1000);
}

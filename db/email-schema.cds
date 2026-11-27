namespace po2so;

using { cuid, managed } from '@sap/cds/common';
using { po2so.InboundOrders } from './inbound-schema';

/**
 * Gmail intake: processing history and sync state.
 *
 * Every Gmail message the poller looked at is recorded once (per mailbox), and every
 * supported attachment once (per mailbox + message + MIME part). The unique constraints
 * make repeated polling, overlapping polls and restarts safe: an attachment can only
 * ever create one InboundOrder.
 *
 * Additive only: new tables plus an unmanaged association on InboundOrders (no new column).
 * OAuth tokens are NOT stored here (see srv/lib/gmail/token-store.js).
 */

type EmailMessageStatus : String(20) enum {
    PROCESSING; // attachments are being handled
    COMPLETED;  // every supported attachment was processed or rejected
    IGNORED;    // no keyword / no supported attachment - never processed
    RETRY;      // a transient error; retried on the next poll
    FAILED;     // still failing after the maximum number of attempts
}

type EmailAttachmentStatus : String(20) enum {
    PROCESSED;  // handed to the intake pipeline -> InboundOrder created
    REJECTED;   // file validation rejected the content (not retried)
    FAILED;     // download / processing error (retried with the message)
}

@assert.unique.message: [mailbox, gmailMessageId]
entity EmailMessages : cuid, managed {
    mailbox              : String(320) not null;
    gmailMessageId       : String(64) not null;
    threadId             : String(64);
    /** RFC 5322 Message-ID header: status e-mails to the sender reply in this thread */
    rfcMessageId         : String(500);
    sender              : String(320);
    subject              : String(500);
    receivedAt           : Timestamp;
    status               : EmailMessageStatus;
    matchedKeyword       : String(100);
    /** Why the message was not processed (IGNORED) */
    ignoreReason         : String(200);
    supportedAttachments : Integer default 0;
    attempts             : Integer default 0;
    lastError            : String(1000);
    attachments          : Composition of many EmailAttachments on attachments.message = $self;
}

@assert.unique.attachment: [mailbox, gmailMessageId, partId]
entity EmailAttachments : cuid, managed {
    message        : Association to EmailMessages;
    mailbox        : String(320) not null;
    gmailMessageId : String(64) not null;
    /** MIME part id - stable for a message (Gmail attachment ids are not) */
    partId         : String(50) not null;
    fileName       : String(255);
    mimeType       : String(100);
    size           : Integer;
    status         : EmailAttachmentStatus;
    errorCode      : String(40);
    errorMessage   : String(1000);
    attempts       : Integer default 0;
    inboundOrder   : Association to InboundOrders;
}

/** Single row (ID = 'gmail'): connection and polling state. No secrets. */
entity GmailSyncState {
    key ID          : String(10);
    emailAddress    : String(320);
    connectedAt     : Timestamp;
    /** Messages received after (cursor - overlap) are listed on the next poll */
    cursor          : Timestamp;
    lastCheckedAt   : Timestamp;
    lastSuccessAt   : Timestamp;
    lastError       : String(1000);
}

/** Gmail origin of an inbound order (null for manual uploads). */
extend InboundOrders with {
    emailAttachment : Association to one EmailAttachments on emailAttachment.inboundOrder = $self;
}

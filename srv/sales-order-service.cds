using { po2so as db } from '../db/schema';
using from '../db/inbound-schema';
using from '../db/email-schema';

// Base64 uploads: 5 MB file limit (cds.po2so.maxFileSize) => ~6.7 MB request body
@cds.server.body_parser.limit: '10mb'
service SalesOrderService {

    entity Customers as projection on db.Customers;

    entity MaterialMappings as projection on db.MaterialMappings;

    entity UomMappings as projection on db.UomMappings;

    entity SalesOrders as projection on db.SalesOrders;

    entity SalesOrderItems as projection on db.SalesOrderItems;

    // ---------------------------------------------------------------
    // Inbound purchase-order intake
    // ---------------------------------------------------------------

    /**
     * Inbound POs. Created only via uploadPurchaseOrder or the Gmail intake.
     * Reviewers may correct extracted header fields / items, then call revalidate().
     */
    @Capabilities.InsertRestrictions.Insertable: false
    entity InboundOrders as projection on db.InboundOrders {
        *,
        @readonly source,
        @readonly fileName,
        @readonly mimeType,
        @readonly soldToParty,
        @readonly status,
        @readonly extractionMethod,
        @readonly extractionConfidence,
        @readonly errorMessage,
        @readonly salesOrderNumber,
        @readonly salesOrder,
        // system-managed: original file reference, validation results and append-only audit log
        @readonly file,
        @readonly issues,
        @readonly events,
        // Gmail origin (sender, subject, attachment) - null for manual uploads
        @readonly emailAttachment,
    } actions {
        /** Re-run mapping + validation on the current (possibly corrected) data. */
        action revalidate() returns InboundOrders;
        /** Discard extracted data and re-extract from the stored original file. */
        action reprocess()  returns InboundOrders;
        /**
         * Fix and resubmit: re-run mapping + validation (including the duplicate check)
         * and, if the order is VALIDATED, create the sales order in SAP.
         */
        action resubmit()   returns InboundOrders;
    };

    entity InboundItems as projection on db.InboundItems {
        *,
        // set when the item is created, never moved to another order afterwards
        @Core.Immutable parent,
        @readonly material,
        @readonly sapUom,
    };

    @readonly entity InboundFiles  as projection on db.InboundFiles;
    @readonly entity InboundIssues as projection on db.InboundIssues;
    @readonly entity InboundEvents as projection on db.InboundEvents;

    type RevalidationResult {
        ID               : UUID;
        customerPoNumber : String(35);
        previousStatus   : String(20);
        status           : String(20);
        errorCount       : Integer;
        /** Technical error if this order could not be revalidated */
        error            : String(1000);
    }

    type RevalidationSummary {
        /** Eligible open orders that were revalidated (or attempted) */
        checked     : Integer;
        /** Orders whose status changed */
        changed     : Integer;
        validated   : Integer;
        needsReview : Integer;
        failed      : Integer;
        /** Orders that could not be revalidated because of a technical error */
        errors      : Integer;
        /** Open orders that were never extracted (nothing to revalidate; fix the file and upload again) */
        skipped     : Integer;
        results     : many RevalidationResult;
    }

    /**
     * Re-run mapping and validation for all open inbound orders (not CREATED or REJECTED),
     * e.g. after mapping master data was maintained. Does not re-extract files and does
     * not change reviewer-entered data.
     */
    action revalidateOpenOrders() returns RevalidationSummary;

    type UploadResult {
        ID               : UUID;
        status           : String(20);
        /** SAP sales order number, set when status is CREATED */
        salesOrderNumber : String(10);
        errorMessage  : LargeString;
        errorCount    : Integer;
        warningCount  : Integer;
    }

    /**
     * Upload a customer PO file (CSV, XLSX or PDF) as Base64.
     * The original file is stored and the intake pipeline is run; a VALIDATED order
     * is posted to SAP immediately (cds.po2so.autoPost).
     */
    action uploadPurchaseOrder(
        fileName   : String(255) not null,
        mimeType   : String(100) not null,
        content    : LargeString not null,   // Base64
        customerId : String(20)              // optional customer identifier (Customers.customerId)
    ) returns UploadResult;

    // ---------------------------------------------------------------
    // Gmail intake (OAuth: GET /auth/gmail/connect and /auth/gmail/callback, see server.js)
    // ---------------------------------------------------------------

    /** Processing history of Gmail messages / attachments (no OAuth data). */
    @readonly entity EmailMessages    as projection on db.EmailMessages;
    @readonly entity EmailAttachments as projection on db.EmailAttachments;

    type GmailStatus {
        /** OAuth client configured (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET set) */
        configured           : Boolean;
        connected            : Boolean;
        emailAddress         : String(320);
        autoPollEnabled      : Boolean;
        pollIntervalMinutes  : Integer;
        /** A sync is running right now */
        polling              : Boolean;
        nextPollAt           : Timestamp;
        connectedAt          : Timestamp;
        lastCheckedAt        : Timestamp;
        lastSuccessAt        : Timestamp;
        lastError            : String(1000);
        emailsChecked        : Integer;
        attachmentsProcessed : Integer;
        /** Attachments that failed or were rejected by file validation */
        attachmentsFailed    : Integer;
        keywords             : String(500);
    }

    type GmailSyncResult {
        startedAt            : Timestamp;
        messagesChecked      : Integer;
        messagesIgnored      : Integer;
        messagesCompleted    : Integer;
        messagesRetry        : Integer;
        messagesFailed       : Integer;
        attachmentsProcessed : Integer;
        attachmentsRejected  : Integer;
        attachmentsFailed    : Integer;
        /** false if more messages are waiting (processed on the next poll) */
        complete             : Boolean;
        /** true if this call waited for a sync that was already running */
        joined               : Boolean;
        errors               : many String(1000);
    }

    /** Gmail connection and polling status. */
    function gmailStatus() returns GmailStatus;

    /**
     * Poll Gmail now. Without backfillDays only mail received since the last poll
     * (minus a small overlap) is read; backfillDays (1-90) explicitly imports older mail.
     */
    action checkGmailNow(backfillDays : Integer) returns GmailSyncResult;

    /** Remove the stored Gmail credentials (processing history is kept). */
    action disconnectGmail() returns GmailStatus;
}

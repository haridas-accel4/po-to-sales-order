using { po2so as db } from '../db/schema';
using from '../db/inbound-schema';

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
     * Inbound POs. Created only via uploadPurchaseOrder (or future e-mail intake).
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
    } actions {
        /** Re-run mapping + validation on the current (possibly corrected) data. */
        action revalidate() returns InboundOrders;
        /** Discard extracted data and re-extract from the stored original file. */
        action reprocess()  returns InboundOrders;
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
        ID            : UUID;
        status        : String(20);
        errorMessage  : LargeString;
        errorCount    : Integer;
        warningCount  : Integer;
    }

    /**
     * Upload a customer PO file (CSV, XLSX or PDF) as Base64.
     * The original file is stored and the intake pipeline is run.
     */
    action uploadPurchaseOrder(
        fileName   : String(255) not null,
        mimeType   : String(100) not null,
        content    : LargeString not null,   // Base64
        customerId : String(20)              // optional customer identifier (Customers.customerId)
    ) returns UploadResult;
}

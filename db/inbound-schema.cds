namespace po2so;

using { cuid, managed } from '@sap/cds/common';
using { po2so.SalesOrders } from './schema';

/**
 * Inbound purchase-order intake model.
 *
 * Every inbound PO (file upload today, e-mail later) is stored as an
 * InboundOrder with its original file, extracted items, current
 * validation issues and an append-only processing log.
 *
 * Status flow:
 *   RECEIVED -> EXTRACTED -> VALIDATED | NEEDS_REVIEW
 *   any step -> FAILED (unrecoverable for this document, e.g. invalid file / duplicate)
 *   VALIDATED -> CREATED (Sales Order created, later phase)
 */
type InboundStatus : String(20) enum {
    RECEIVED;
    EXTRACTED;
    VALIDATED;
    NEEDS_REVIEW;
    CREATED;
    FAILED;
}

type InboundSource : String(10) enum {
    UPLOAD;
    EMAIL;
}

type IssueSeverity : String(10) enum {
    ERROR;   // blocks Sales Order creation -> NEEDS_REVIEW / FAILED
    WARNING; // informational, does not block
}

entity InboundOrders : cuid, managed {
    source                 : InboundSource default 'UPLOAD';
    fileName               : String(255);
    mimeType               : String(100);

    customerPoNumber       : String(35);
    poDate                 : Date;
    /** Default requested delivery date; an item's own requestedDeliveryDate takes precedence */
    requestedDeliveryDate  : Date;
    /** Document currency of the customer's prices (e.g. USD) */
    currency               : String(5);

    /** Customer identifier supplied with the document (maps via Customers.customerId) */
    customerId             : String(20);
    /** Resolved Sold-to party (only set from the Customers mapping) */
    soldToParty            : String(10);

    status                 : InboundStatus default 'RECEIVED';
    extractionMethod       : String(30);
    extractionConfidence   : Decimal(4,3);
    errorMessage           : LargeString;

    salesOrderNumber       : String(10);
    salesOrder             : Association to SalesOrders;

    file   : Composition of one InboundFiles;
    items  : Composition of many InboundItems  on items.parent  = $self;
    issues : Composition of many InboundIssues on issues.parent = $self;
    events : Composition of many InboundEvents on events.parent = $self;
}

/** Original uploaded document, preserved unchanged. */
entity InboundFiles : cuid, managed {
    fileName  : String(255);
    mimeType  : String(100);
    size      : Integer;
    sha256    : String(64);
    content   : LargeBinary @Core.MediaType: mimeType @Core.ContentDisposition.Filename: fileName;
}

entity InboundItems : cuid {
    parent             : Association to InboundOrders;

    lineNumber         : Integer;
    customerMaterial   : String(35);
    description        : String(100);
    quantity           : Decimal(13,3);
    customerUom        : String(10);

    /** Customer's price as stated on the PO - informational only, never used as SAP price */
    customerUnitPrice  : Decimal(15,2);
    /** Quantity the customer's unit price refers to (e.g. 100 = price per 100 units) */
    priceUnit          : Integer default 1;

    /** Item-level requested delivery date; null = use the order's requestedDeliveryDate */
    requestedDeliveryDate : Date;

    /** Derived from MaterialMappings / UomMappings only - never typed in freely */
    material           : String(40);
    sapUom             : String(3);
}

/** Current validation findings (replaced on every validation run). */
entity InboundIssues : cuid, managed {
    parent      : Association to InboundOrders;
    severity    : IssueSeverity;
    code        : String(40);
    field       : String(40);
    lineNumber  : Integer;
    message     : String(500);
}

/** Append-only processing log for traceability. */
entity InboundEvents : cuid, managed {
    parent   : Association to InboundOrders;
    status   : InboundStatus;
    message  : String(1000);
}

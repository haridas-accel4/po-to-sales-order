
namespace po2so;

using { cuid, managed } from '@sap/cds/common';

// Customer and Sales Area Mapping
entity Customers {
    key customerId       : String(20);
    customerName         : String(100);
    soldToParty           : String(10);
    salesOrganization     : String(4);
    distributionChannel   : String(2);
    division              : String(2);
    active                : Boolean default true;
    /**
     * Values that identify this customer on its POs or e-mails, ';' or line separated, e.g.
     * our supplier number at the customer, its VAT number, company name or e-mail domain.
     * Used to find the customer of a PO that arrives without one (srv/lib/customer-identification.js).
     */
    identifiers           : String(1000);
}

// Customer Material to SAP Material Mapping
entity MaterialMappings {
    key soldToParty       : String(10);
    key customerMaterial  : String(35);
    material              : String(40);
    description           : String(100);
    active                : Boolean default true;
}

// External UOM to SAP UOM Mapping
entity UomMappings {
    key externalUom       : String(10);
    sapUnit               : String(3);
}

// Sales Order Header
entity SalesOrders : cuid, managed {
    customerPoNumber       : String(35);
    poDate                 : Date;
    requestedDeliveryDate  : Date;

    soldToParty            : String(10);
    salesOrganization      : String(4);
    distributionChannel    : String(2);
    division               : String(2);

    currency               : String(5);
    status                 : String(20);
    salesOrderNumber       : String(10);
    errorMessage           : LargeString;

    items : Composition of many SalesOrderItems
        on items.parent = $self;
}

// Sales Order Line Items
entity SalesOrderItems : cuid {
    parent                 : Association to SalesOrders;

    itemNumber             : Integer;
    customerMaterial       : String(35);
    material               : String(40);
    description            : String(100);

    quantity               : Decimal(13,3);
    uom                    : String(10);
    unitPrice              : Decimal(15,2);
}


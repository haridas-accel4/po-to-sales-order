/*
 * SAP Cloud ERP Sales Order API (OData V2), communication scenario SAP_COM_0109.
 *
 * Hand-written subset of API_SALES_ORDER_SRV with the field names of the released
 * API, so the app can be built and tested against the local CAP mock without tenant
 * access. It contains only the fields this app reads or writes.
 *
 * To switch to the full model, download the EDMX from SAP Business Accelerator Hub
 * and run:  cds import API_SALES_ORDER_SRV.edmx --as cds --force
 * The import replaces this file; the field names used by srv/lib/sap-sales-order.js
 * stay the same.
 */
@cds.external: true
service API_SALES_ORDER_SRV {

    @cds.external: true
    @cds.persistence.skip: true
    entity A_SalesOrder {
        key SalesOrder              : String(10);
            SalesOrderType          : String(4);
            SalesOrganization       : String(4);
            DistributionChannel     : String(2);
            OrganizationDivision    : String(2);
            SoldToParty             : String(10);
            PurchaseOrderByCustomer : String(35);
            @odata.Type: 'Edm.DateTime'
            @odata.Precision: 0
            CustomerPurchaseOrderDate : Date;
            @odata.Type: 'Edm.DateTime'
            @odata.Precision: 0
            RequestedDeliveryDate   : Date;
            @odata.Type: 'Edm.DateTime'
            @odata.Precision: 0
            CreationDate            : Date;
            TotalNetAmount          : Decimal(16, 3);
            TransactionCurrency     : String(5);
            OverallSDProcessStatus  : String(1);
            OverallDeliveryStatus   : String(1);
            to_Item                 : Composition of many A_SalesOrderItem
                                          on to_Item.SalesOrder = SalesOrder;
    }

    @cds.external: true
    @cds.persistence.skip: true
    entity A_SalesOrderItem {
        key SalesOrder            : String(10);
        key SalesOrderItem        : String(6);
            SalesOrderItemText    : String(40);
            Material              : String(40);
            MaterialByCustomer    : String(35);
            RequestedQuantity     : Decimal(15, 3);
            RequestedQuantityUnit : String(3);
            NetAmount             : Decimal(16, 3);
            TransactionCurrency   : String(5);
            to_SalesOrder         : Association to one A_SalesOrder
                                        on to_SalesOrder.SalesOrder = SalesOrder;
    }
}

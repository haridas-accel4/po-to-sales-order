# Getting Started

Welcome to your new CAP project.

It contains these folders and files, following our recommended project layout:

File or Folder | Purpose
---------|----------
`app/` | content for UI frontends goes here
`db/` | your domain models and data go here
`srv/` | your service models and code go here
`readme.md` | this getting started guide

## Next Steps

- Open a new terminal and run `cds watch`
- (in VS Code simply choose _**Terminal** > Run Task > cds watch_)
- Start with your domain model, in a CDS file in `db/`

## Learn More

Learn more at <https://cap.cloud.sap>.

## Purchase Order File Templates

POs are read deterministically from fixed templates (one PO per file):

- **CSV / XLSX**: one row per item with the columns
  `CustomerPO, PODate, DeliveryDate, Line, CustomerMaterial, Description, Quantity, UoM, UnitPrice`
  (any order, case-insensitive, extra columns ignored). Samples: `test/fixtures/sample-po.csv`, `sample-po.xlsx`.
- **PDF** (text PDF, not a scan): labelled header fields and an item table, e.g.

  ```
  Customer PO:    PO-2027-0201
  PO Date:        2027-04-01
  Delivery Date:  2027-04-20          (optional)

  Line  Customer Material  Description   Quantity  UoM  Unit Price
  10    ACME-BOLT-10       Hex bolt M10  100       PCS  0.25
  ```

  Labels may also be written `PO Number:` / `PO No.:` / `Purchase Order:` and `Order Date:` / `Created on:`.
  Table columns are matched by name or a common synonym (`Item`, `ID`, `Qty`, `Net Price`, ...; spaces and
  case ignored), may be in any order, and extra columns such as `Total` are ignored. Only `Line`,
  `Customer Material` and `Quantity` are required. A `Delivery Date` column is the item's date; without a
  `Delivery Date:` label the order uses the earliest item date. Wrapped descriptions are joined; a table
  spanning pages repeats its header row. Sample: `test/fixtures/sample-po-template.pdf`
  (`node test/fixtures/generate-pdf.js`).
- **SAP purchase order PDF** (the standard S/4HANA PO output form) is read as is: `Purchase Order:` /
  `Created on:`, the table `Item | ID | Description | Quantity | Delivery Date | Net Price | Net Value`,
  the unit inside the quantity (`1 PC`), the currency inside the price (`13.00 USD`) and the price unit
  below it (`per 1 PC`); schedule lines and Incoterms are ignored. Thousands separators are accepted
  there, with the decimal separator taken from the prices (`1,000 PC` / `13.00 USD` or `1.000 ST` / `13,00 EUR`).

Values follow the same rules in every format: dates `YYYY-MM-DD`, `DD.MM.YYYY` or with an English month
name (`Mar 6, 2026`, `6 Mar 2026`; slash dates are rejected as ambiguous), `.` as decimal separator, no
thousands separators (except in SAP PDFs, see above). The UoM may be empty: SAP then uses the unit from
the material master (warning). Files that do not match the template end up in Exceptions with the reason.

Field rules from the PO-to-SO mapping: the PO number becomes the customer reference
(`PurchaseOrderByCustomer`); the sales order is created in the PO's currency (`TransactionCurrency`), but
the PO price is never sent because selling prices may differ (SAP pricing decides); tax is determined by SAP. PDF reading can be switched off with `cds.po2so.pdfExtraction.provider = "none"`
(AI extraction for arbitrary layouts, `document-ai` / `gen-ai-hub`, is not implemented).

## Gmail Intake

Customer purchase orders can be read directly from a Gmail mailbox (read-only). Matching email
attachments (PDF, XLSX, CSV) run through the same intake pipeline as manual uploads.

- Setup, configuration, polling and disconnecting: [docs/gmail-setup.md](docs/gmail-setup.md)
- Local secrets go into `.env` (template: `.env.example`, never committed)
- Existing database: `npm run db:migrate` (backup + additive changes only; `npm run deploy:local` re-creates all tables)

## SAP S/4HANA Connection

Valid POs are created as sales orders through the Sales Order API (`API_SALES_ORDER_SRV`, OData V2).

- **Local / hybrid**: set `S4_SALES_ORDER_API_URL` (service root, e.g.
  `https://<tenant>-api.s4hana.cloud.sap/sap/opu/odata/sap/API_SALES_ORDER_SRV`), `S4_USER` and
  `S4_PASSWORD` in `.env` (template: `.env.example`). Quote the password with single quotes if it
  contains `#`, `$` or spaces.
- **Production**: BTP destination `S4HC_SALES` (`package.json`, `[production]` profile).
- **Nothing configured** (and always under `npm test`): the local mock `srv/external/API_SALES_ORDER_SRV.js`.

At startup the server logs whether the API is reachable (`[po2so] - Connected to the SAP Sales Order API at ...`
or the reason it is not, e.g. HTTP 401). `GET /odata/v4/sales-order/sapStatus()` runs the same check on demand.
After creating an order the app stores the sales order number returned by SAP and shows it on the PO.

## Order Status E-mails

- **Internal exceptions**: when SAP sales order creation fails (SAP rejects the order, the PO already
  exists in SAP, or SAP is not reachable), and for e-mailed POs also when the PO cannot be read, needs
  review or is a duplicate, an exception e-mail with the customer, PO number, status, error messages
  and time is sent to `haridas.shinde@accel4.com` (configurable).
- **E-mailed POs, created**: a "sales order created" e-mail internally, and an order confirmation
  with our sales order number to the customer, as a reply in their thread.
- **E-mailed POs, needs attention**: the customer gets one "we received your PO and are reviewing it" reply.

Sending uses its own SMTP settings, separate from the read-only Gmail intake, and never affects order processing.

- Setup and behaviour: [docs/failure-notifications.md](docs/failure-notifications.md)
- Settings go into `.env` (`SMTP_*`, `SO_FAILURE_EMAIL_*`, `SO_CREATED_EMAIL_*`, `PO_CUSTOMER_EMAIL_*`; template: `.env.example`)
- Existing local database: run `npm run db:migrate` once (adds `EmailMessages.rfcMessageId` and `FailureNotifications.audience`)

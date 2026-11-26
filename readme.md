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

  Labels may also be written `PO Number:` / `PO No.:` and `Order Date:`. Table columns are matched
  by name (spaces and case ignored), may be in any order, and extra columns such as `Total` are ignored.
  Wrapped descriptions are joined; a table spanning pages repeats its header row. Sample:
  `test/fixtures/sample-po-template.pdf` (`node test/fixtures/generate-pdf.js`).

Values follow the same rules in every format: dates `YYYY-MM-DD` or `DD.MM.YYYY`, `.` as decimal
separator, no thousands separators. Files that do not match the template end up in Exceptions with
the reason. PDF reading can be switched off with `cds.po2so.pdfExtraction.provider = "none"`
(AI extraction for arbitrary layouts, `document-ai` / `gen-ai-hub`, is not implemented).

## Gmail Intake

Customer purchase orders can be read directly from a Gmail mailbox (read-only). Matching email
attachments (PDF, XLSX, CSV) run through the same intake pipeline as manual uploads.

- Setup, configuration, polling and disconnecting: [docs/gmail-setup.md](docs/gmail-setup.md)
- Local secrets go into `.env` (template: `.env.example`, never committed)
- Existing database: `npm run db:migrate` (backup + additive changes only; `npm run deploy:local` re-creates all tables)

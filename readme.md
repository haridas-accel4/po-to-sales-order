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

## Gmail Intake

Customer purchase orders can be read directly from a Gmail mailbox (read-only). Matching email
attachments (PDF, XLSX, CSV) run through the same intake pipeline as manual uploads.

- Setup, configuration, polling and disconnecting: [docs/gmail-setup.md](docs/gmail-setup.md)
- Local secrets go into `.env` (template: `.env.example`, never committed)
- Existing database: `npm run db:migrate` (backup + additive changes only; `npm run deploy:local` re-creates all tables)

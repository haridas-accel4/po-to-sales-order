# Order Status E-mails

Nobody has to watch the app to learn what happened to a PO:

- **Internal team** (default **haridas.shinde@accel4.com**): an exception e-mail whenever a PO
  needs attention, and, for e-mailed POs, a "sales order created" e-mail.
- **Customer** (the sender of an e-mailed PO): a reply in their own e-mail thread, "we received
  your PO and are reviewing it" when the PO needs attention, and an order confirmation with our
  sales order number once it is created.

An internal exception e-mail contains everything needed to investigate:

- customer name, customer ID, sold-to party
- customer PO number, PO date, requested delivery date, sales area
- sales order status and failure reason (with the HTTP status if there is one)
- SAP error message(s)
- date and time of the failure (UTC)
- source (manual upload or Gmail, with sender / subject), file name, inbound order ID, items
- for e-mailed POs: what the customer was told ("Customer e-mail" line)

Sending is **separate from the Gmail intake**: it uses its own SMTP account and settings,
never the Gmail read-only OAuth client or token. The intake only additionally stores each
e-mail's `Message-ID`, so that customer e-mails can reply in the same thread.

## When an e-mail is sent

| Event               | Situation                                           | Order status | Internal (`SO_FAILURE_EMAIL_TO`) | Customer (e-mailed POs) |
|---------------------|-----------------------------------------------------|--------------|----------------------------------|-------------------------|
| `SAP_REJECTED`      | SAP rejected the data (HTTP 4xx business error)     | FAILED       | exception (any channel)          | "under review" |
| `SAP_DUPLICATE`     | a sales order for the customer PO already exists in SAP | FAILED   | exception (any channel)          | "under review" |
| `SAP_UNAVAILABLE`   | SAP not reachable / not authorized / timeout        | VALIDATED (resubmit) | exception (any channel, configurable) | "under review" |
| `NEEDS_REVIEW`      | missing customer, mapping or data at intake         | NEEDS_REVIEW | exception (e-mailed POs)         | "under review" |
| `DUPLICATE_PO`      | the customer PO already exists in the app           | FAILED       | exception (e-mailed POs)         | "under review" |
| `EXTRACTION_FAILED` | the attachment could not be read                    | FAILED       | exception (e-mailed POs)         | – (the file may not be a PO) |
| `SO_CREATED`        | sales order created in SAP                          | CREATED      | "created" (e-mailed POs, `SO_CREATED_EMAIL_TO`) | order confirmation |

- Intake events (`NEEDS_REVIEW`, `DUPLICATE_PO`, `EXTRACTION_FAILED`) are sent once, when the
  e-mail is processed. Later edits and revalidations in the review dialog send nothing.
- Manually uploaded POs only get the SAP exception e-mails, as before: the uploader sees the
  result in the app straight away, and there is no customer address.
- The customer gets **"under review" at most once per e-mail** (also when it holds several POs),
  and the **confirmation once per order**. Both reply in the customer's thread (`Re: <subject>`,
  `In-Reply-To`) and contain only the customer's own data and our sales order number: no prices
  (SAP pricing may differ from the PO), no SAP or validation messages, no internal IDs.
- No customer e-mail goes to this application's own addresses (the polled mailbox or the sender).
- Today every e-mailed PO first stops at NEEDS_REVIEW (the customer is assigned in the review),
  so a customer first gets "under review" and then the confirmation after the resubmit.
- The "created" e-mail is sent per order. A daily summary instead is a planned production option.

Set `cds.po2so.failureNotification.notifyOnSapUnavailable = false` to skip `SAP_UNAVAILABLE`.

## Behaviour

- **Never affects the order.** The e-mail is sent after the order's transaction has committed,
  in the background. SMTP errors, timeouts or a missing configuration are logged (logger
  `notification`) and never change the order status or the API response. If the transaction
  rolls back, nothing is sent.
- **No duplicates.** Each e-mail is recorded once in `FailureNotifications` (unique `dedupKey`;
  column `audience` = INTERNAL / CUSTOMER, `failureType` = the event). For exceptions the key is
  order + type + messages: resubmitting an order that fails the same way again sends nothing,
  while a *different* SAP error for the same order is e-mailed. "Under review" is keyed by the
  customer's e-mail, "created" and the confirmation by the order.
- **Customer first.** The customer e-mail of an event is sent before the internal one, so the
  internal e-mail states whether the customer was actually told.
- **Retries.** Network errors and temporary SMTP replies (4xx) are retried 3 times with
  exponential backoff (2 s, 4 s, 8 s). Permanent errors (wrong credentials, rejected address,
  5xx, TLS problems) are not retried. The row then has status `SEND_FAILED` with `lastError`,
  and it is sent when the same failure occurs again (e.g. on the next resubmit).
- **History.** The database table `po2so_FailureNotifications` records every notification
  (status, attempts, recipients, last error). No credentials are stored.

## Configuration

Secrets go into `.env` only (template: `.env.example`, never committed).

| Variable                    | Default                    | Meaning |
|-----------------------------|----------------------------|---------|
| `SO_FAILURE_EMAIL_TO`       | `haridas.shinde@accel4.com`  | recipient(s), comma-separated |
| `SO_FAILURE_EMAIL_FROM`     | `SMTP_USER`                | sender, `Name <address>` allowed |
| `SO_FAILURE_EMAIL_ENABLED`  | `true`                     | switch all e-mails off |
| `SO_CREATED_EMAIL_TO`       | `SO_FAILURE_EMAIL_TO`      | recipient(s) of the internal "created" e-mail |
| `SO_CREATED_EMAIL_ENABLED`  | `true`                     | switch the internal "created" e-mail off |
| `PO_CUSTOMER_EMAIL_ENABLED` | `true`                     | switch the customer e-mails off |
| `PO_CUSTOMER_EMAIL_REPLY_TO`| –                          | where customer answers go, e.g. `Order Desk <orders@accel4.com>` |
| `PO_CUSTOMER_EMAIL_SIGNATURE` | `Customer Service`       | sign-off of the customer e-mails |
| `SMTP_HOST`                 | –                          | SMTP submission server; empty = sending not configured |
| `SMTP_PORT`                 | `587` (`465` if secure)    | |
| `SMTP_SECURE`               | `false`                    | `true` = implicit TLS (port 465); `false` = STARTTLS |
| `SMTP_USER` / `SMTP_PASSWORD` | –                        | SMTP login of the sending mailbox |
| `SMTP_REQUIRE_TLS`          | `true`                     | refuse servers without STARTTLS; `false` only for a trusted local relay |

Tuning in `package.json` (`cds.po2so.failureNotification`): `retry` (`{ retries, baseDelayMs }`),
`timeoutMs`, `notifyOnSapUnavailable`, `stalePendingMinutes`.

### Provider examples

Use a dedicated sender mailbox (e.g. `po2so-noreply@accel4.com`), not a personal account.

- **Google Workspace**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<mailbox>`,
  `SMTP_PASSWORD=<app password>` (requires 2-step verification on that mailbox; or use the
  Workspace SMTP relay `smtp-relay.gmail.com` configured by the admin).
- **Microsoft 365**: `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`; SMTP AUTH must be
  enabled for the mailbox.
- **SendGrid / other relay**: host, port and API-key login as documented by the provider.

### Testing locally without real e-mail

Run a local SMTP catcher such as [Mailpit](https://mailpit.axllent.org/) (Windows: `winget install axllent.mailpit`,
then start `mailpit`; SMTP on port 1025, web UI on <http://localhost:8025>). Mailpit catches every
message, whatever the recipient, and delivers nothing. Its default setup has no TLS and no login, so set in `.env`:

```
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_USER=
SMTP_PASSWORD=
SO_FAILURE_EMAIL_FROM=PO2SO Notifications <po2so@localhost.test>
```

Leave `SMTP_USER` empty: credentials are never sent without TLS except to a loopback address, and
Mailpit rejects a login it was not configured for. Restart the app after changing `.env`.
Then upload a PO whose material is mapped to one SAP does not know (e.g. `TG99`; the local SAP mock rejects it).

Automated tests (`test/unit/failure-notification.test.js`, `test/api/failure-notification.test.js`)
use an in-process fake SMTP server; no e-mail ever leaves the machine.

### Existing local database

The notification history is a new table. Run `npm run db:migrate` (backup + additive changes)
once. Until then sending is skipped and an error is logged; order processing is not affected.

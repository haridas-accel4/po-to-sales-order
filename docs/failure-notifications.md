# Sales Order Exception E-mails

When SAP sales order creation fails, the app e-mails the sales operations team
(default **haridas.shinde@accel4.com**) with everything needed to investigate:

- customer name, customer ID, sold-to party
- customer PO number, PO date, requested delivery date, sales area
- sales order status and failure reason (with the HTTP status if there is one)
- SAP error message(s)
- date and time of the failure (UTC)
- source (manual upload or Gmail, with sender / subject), file name, inbound order ID, items

Sending is **separate from the Gmail intake**: it uses its own SMTP account and settings,
never the Gmail read-only OAuth client or token. The Gmail intake is unchanged.

## When an e-mail is sent

Only from `postSalesOrder` (srv/lib/pipeline.js), i.e. when the app tried to create the sales order in SAP:

| Failure type      | Situation                                          | Order status afterwards |
|-------------------|----------------------------------------------------|-------------------------|
| `SAP_REJECTED`    | SAP rejected the data (HTTP 4xx business error)    | FAILED                  |
| `SAP_DUPLICATE`   | a sales order for the customer PO already exists in SAP | FAILED             |
| `SAP_UNAVAILABLE` | SAP not reachable / not authorized / timeout       | VALIDATED (resubmit)    |

No e-mail is sent for a successful sales order, or for orders stopped by validation
before SAP is called (NEEDS_REVIEW, duplicate found in the app). Set
`cds.po2so.failureNotification.notifyOnSapUnavailable = false` to skip `SAP_UNAVAILABLE`.

## Behaviour

- **Never affects the order.** The e-mail is sent after the order's transaction has committed,
  in the background. SMTP errors, timeouts or a missing configuration are logged (logger
  `notification`) and never change the order status or the API response. If the transaction
  rolls back, nothing is sent.
- **No duplicates.** Each failure (order + failure type + SAP messages) is recorded once in
  `FailureNotifications` (unique `dedupKey`). Resubmitting an order that fails the same way
  again sends nothing. A *different* SAP error for the same order is a new failure and is e-mailed.
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
| `SO_FAILURE_EMAIL_ENABLED`  | `true`                     | switch the e-mails off |
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

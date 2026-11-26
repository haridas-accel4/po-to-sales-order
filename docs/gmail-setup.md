# Gmail Intake: Setup and Operation

The app can read customer purchase orders straight from a Gmail mailbox. Every matching
email attachment (PDF, XLSX or CSV) is processed by **the same intake pipeline as a manual
upload**: file validation, storage of the original file, extraction, customer / material /
UoM mapping, validation and duplicate checks. The result appears in *Processed POs* or
*Exceptions* like any uploaded PO.

Gmail is accessed **read-only** (`https://www.googleapis.com/auth/gmail.readonly`). The app
never sends, deletes, moves, labels, archives or marks emails as read.

---

## 1. Google Cloud setup (one time)

1. **Create a project** at <https://console.cloud.google.com/> (project selector, then *New Project*),
   e.g. `po-to-sales-order-dev`.
2. **Enable the Gmail API**: *APIs & Services > Library*, search for **Gmail API**, then *Enable*.
3. **Configure the OAuth consent screen** (*Google Auth Platform > Branding / Audience / Data access*,
   or *APIs & Services > OAuth consent screen* in the older console):
   - *User type / Audience*: **External** for a personal Gmail account
     (**Internal** for a company Google Workspace, see section 7).
   - App name, user support email and developer contact email: your values.
   - *Data access / Scopes*: add `https://www.googleapis.com/auth/gmail.readonly` only.
   - *Test users*: add the Gmail address you are going to connect.
   - Leave the publishing status on **Testing** for local development.
4. **Create the OAuth client**: *APIs & Services > Credentials > Create credentials > OAuth client ID*
   - Application type: **Web application**
   - Authorized redirect URI: **`http://localhost:4004/auth/gmail/callback`**
     (exactly the value of `GMAIL_REDIRECT_URI`)
   - Copy the **Client ID** and **Client secret**.

> **Testing-mode limitation:** while the consent screen is in *Testing*, Google expires refresh
> tokens after **7 days**. The Gmail dialog then shows *Reconnect required*; click **Reconnect**.
> `gmail.readonly` is a *restricted* scope: publishing the app for arbitrary external users requires
> Google's verification and a security assessment. A company Workspace with an **Internal** app
> avoids both (section 7).

## 2. Local configuration

Copy `.env.example` to `.env` in the project root and fill it in. `.env` is excluded from Git.

```env
GMAIL_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...
GMAIL_REDIRECT_URI=http://localhost:4004/auth/gmail/callback
GMAIL_POLL_INTERVAL_MINUTES=5
GMAIL_AUTO_POLL_ENABLED=true
```

| Variable | Purpose |
|---|---|
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | OAuth client from step 4. Without them the Gmail dialog shows *Not configured*. |
| `GMAIL_REDIRECT_URI` | Callback URL; must match the OAuth client exactly. |
| `GMAIL_POLL_INTERVAL_MINUTES` | Minutes between automatic polls (minimum 1, default 5). |
| `GMAIL_AUTO_POLL_ENABLED` | `false` disables automatic polling; *Check Gmail Now* still works. |
| `GMAIL_TOKEN_FILE` *(optional)* | Location of the encrypted token file (default `<home>/.po2so/gmail-token.json`). |
| `GMAIL_TOKEN_ENCRYPTION_KEY` *(optional)* | Key for the token file (default: derived from the client secret). |
| `GMAIL_KEYWORDS` *(optional)* | Comma-separated keywords, overriding `package.json`. |

`server.js` loads `.env` when the server starts (`cds watch`, `npm start`). Values that are
already set as real environment variables take precedence. Restart the server after changes.

Non-secret behaviour is configured in `package.json` under `cds.po2so.gmail`:

```json
"gmail": {
  "keywords": ["Purchase Order", "PO", "Sales Order", "SO"],
  "attachmentExtensions": ["pdf", "xlsx", "csv"],
  "overlapMinutes": 10,
  "maxMessagesPerPoll": 50,
  "maxAttempts": 5
}
```

A keyword can also be an object, e.g. `{ "term": "SO", "caseSensitive": true }`, if the
lower-case word "so" in ordinary sentences should not count as a match.

## 3. Database

Gmail intake adds three tables (`EmailMessages`, `EmailAttachments`, `GmailSyncState`). Existing
tables are not changed.

- **Existing `db.sqlite` (keeps all data):** `npm run db:migrate`
  - Writes a full backup first (`db.backup-<timestamp>.sqlite`, next to `db.sqlite`).
  - Only creates missing tables, columns and views, in one transaction. It never drops anything.
  - `npm run db:migrate -- --dry-run` shows the planned changes without applying them.
- **New, empty database:** `npm run deploy:local`. Warning: `cds deploy` **re-creates all tables and
  deletes existing data**. Do not use it on a database you want to keep.

## 4. Connecting Gmail locally

1. `cds watch` (or `npm start`). The app runs on <http://localhost:4004/sales-order/webapp/index.html>.
2. Click **Gmail** in the header. The dialog shows *Not connected*.
3. Click **Connect Gmail**. You are sent to Google's consent screen.
4. Sign in with the test user and allow *View your email messages and settings*.
   Because the app is unverified in *Testing*, Google shows a warning: choose *Continue*.
5. Google redirects to `/auth/gmail/callback`, and the app returns to the main page with the dialog
   showing *Connected* and the Gmail address.

**What happens on the server:**
- `/auth/gmail/connect` creates a random, single-use `state` value. It expires after 10 minutes and
  is also set as an HttpOnly cookie. The browser is then redirected to Google (`access_type=offline`,
  `prompt=consent`, scope `gmail.readonly`).
- `/auth/gmail/callback` accepts the request only if the returned `state` is known, unexpired, unused
  and equal to the cookie of the same browser (CSRF protection).
- It then exchanges the code for tokens, checks that the read-only scope was granted and that a
  refresh token was issued, reads the mailbox address and stores the credentials.
- Credentials are stored **encrypted (AES-256-GCM) in a file outside the project folder**. They
  survive restarts and are never written to the database, never sent to the browser and never
  returned by an OData call.
- From the moment of connection, only **new** emails are read. Older mail is imported only on
  explicit request (see *Backfill* in section 5).

## 5. How polling works

- Every `GMAIL_POLL_INTERVAL_MINUTES` the server polls Gmail. It starts only while a mailbox is
  connected. *Check Gmail Now* triggers a poll immediately. Polls never overlap: a second request
  waits for the running poll and returns its result.
- **What a poll does:**
  1. **Retries:** retries messages left in `RETRY` (temporary error) or `PROCESSING` (for example,
     the server stopped mid-way).
  2. **Search:** lists messages received after *cursor - overlap* (10 minutes) that have a
     `.pdf`, `.xlsx` or `.csv` attachment (Gmail search, not the whole mailbox).
  3. **Known messages:** messages already in the history are skipped without being downloaded again.
  4. **Keyword check:** looks for a keyword in the subject or body (plain text, or HTML converted to
     text). `PO` and `SO` count only as standalone words: `PO 4711`, `PO#4711` and `POs` match;
     `report`, `photo` and `POST` do not.
  5. **Attachments:** every supported attachment of a matching email is processed separately and
     becomes its own inbound PO. Inline images and other files are ignored. Content is validated by
     the pipeline; file names and MIME types are not trusted.
  6. **Cursor:** the cursor advances only when the poll saw every listed message (at most 50 new
     messages per poll; more are taken on the next poll).
- **Customer:** an email does not identify the SAP customer, so Gmail POs arrive without a customer
  and are set to *Needs Review* by the existing validation. A reviewer selects the customer in the
  review dialog; Save re-runs mapping, validation and the duplicate check. Nothing is guessed from
  the sender.
- **Duplicates and restarts:** each message is recorded once per mailbox and each attachment once
  per mailbox, message and MIME part. This is enforced by unique database constraints. An attachment
  and its inbound PO are saved in one transaction, so a restart or repeated poll can never create a
  second PO for the same attachment. The existing PO-number duplicate check still applies once the
  customer is known.
- **Failures:**
  - Temporary Gmail errors (network, HTTP 429/5xx) are retried with backoff.
  - An attachment that still fails is marked `FAILED` and retried with the message on later polls,
    up to 5 attempts, while the other attachments are processed normally.
  - A file rejected by validation (wrong content, too large) is marked `REJECTED` and not retried.
  - The Gmail dialog shows these attachments and the number of failed attachments.
- **Backfill:** to import older mail once, call the action with the number of days (1-90):
  ```http
  POST /odata/v4/sales-order/checkGmailNow
  Content-Type: application/json

  { "backfillDays": 7 }
  ```
- Errors are logged without tokens or secrets. An expired or revoked authorization stops the poll
  and shows *Reconnect required*.
- **Auto-post to SAP:** if `cds.po2so.autoPost` is on, a Gmail PO that is fully valid is posted
  exactly like an uploaded one. Because the customer is never set automatically, this normally
  happens after review.

## 6. Disconnecting

Click **Gmail > Disconnect** and confirm. The stored credentials are deleted (and revoked at Google,
best effort) and polling stops. Imported POs and the email processing history are kept. You can also
remove the app's access at <https://myaccount.google.com/permissions>.

## 7. Switching to a company Gmail / Google Workspace account

1. Disconnect the personal mailbox in the app.
2. In the company's Google Cloud organisation, create or choose a project, enable the Gmail API
   and configure the consent screen with audience **Internal**. Internal apps need no Google
   verification, and refresh tokens are not limited to 7 days.
3. Create a *Web application* OAuth client with the production redirect URI, e.g.
   `https://<your-host>/auth/gmail/callback`, and put the new values in the environment.
4. Connect the company mailbox (e.g. a shared `orders@company.com` account). Its history is kept
   separately: messages are recorded per mailbox. Polling starts from the connection time; use a
   backfill if older mail is needed.

**Before a production deployment:**
- **Token storage:** replace the file-based token store (`srv/lib/gmail/token-store.js`:
  `loadCredentials` / `saveCredentials` / `clearCredentials`) with a managed secret store such as
  SAP BTP Credential Store, and supply client ID and secret through the platform's environment
  or a destination.
- **Access control:** protect `/auth/gmail/*` and the Gmail actions with the app's authentication
  and authorization. The current app has no user authentication at all.
- **Single poller:** run polling in one instance only. The database constraints already prevent
  duplicates if two instances poll.

## 8. API reference

| Endpoint | Purpose |
|---|---|
| `GET /auth/gmail/connect` | Starts OAuth (browser redirect to Google). 503 if not configured. |
| `GET /auth/gmail/callback` | OAuth callback. 400 on an invalid state, otherwise redirects to the app (`?gmail=connected` or `?gmail=error`). |
| `GET /odata/v4/sales-order/gmailStatus()` | Connection, polling and processing figures (no secrets). |
| `POST /odata/v4/sales-order/checkGmailNow` | Poll now; optional `backfillDays` (1-90). 409 `GMAIL_NOT_CONNECTED` / `GMAIL_RECONNECT_REQUIRED`. |
| `POST /odata/v4/sales-order/disconnectGmail` | Remove the stored credentials. |
| `GET /odata/v4/sales-order/EmailMessages`, `EmailAttachments` | Read-only processing history. |
| `InboundOrders?$expand=emailAttachment($expand=message)` | Gmail origin of an order (sender, subject, attachment). |

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| *Not configured* | `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` missing in `.env`; restart the server. |
| Google: `redirect_uri_mismatch` | The redirect URI in the OAuth client differs from `GMAIL_REDIRECT_URI` (scheme, host, port, path). |
| Google: `access_denied` / "app not verified" blocked | Add your address as a *Test user* on the consent screen. |
| "did not return a refresh token" | Remove the app at myaccount.google.com/permissions and connect again. |
| *Reconnect required* | Refresh token expired (7 days in Testing) or revoked; click **Reconnect**. |
| Email not imported | Check the keyword (subject/body), the attachment type, and that it arrived after the connection time. Look at `EmailMessages` (`IGNORED` with `ignoreReason`). |

# Data Protection Policies — VedaSuite AI

Last reviewed: 2026-07-25
Owner: Abhimanyu (abhimanyu@vedasuite.in)

These are the written policies backing the Data protection details declaration in
the Shopify Partner Dashboard. They describe controls that are actually in place.
Anything not yet in place is listed under "Known gaps" rather than described as if
it were operating.

## 1. Scope and roles

VedaSuite AI is operated by a single administrator. There is no separate
engineering, support, or operations team. That one person holds every role
described below.

Systems in scope:

| System | Holds personal data? | Purpose |
|---|---|---|
| Render (web service) | In transit only | Runs the app backend |
| Render managed PostgreSQL | Yes | Store, order, customer, fraud records |
| Render logs | Diagnostic identifiers only | Operational logging |
| GitHub | No | Source code |
| Shopify Partner Dashboard | No | App configuration |

Personal data handled: customer identifiers and contact details, order and refund
records, and derived fraud/trust signals — all obtained from Shopify Admin APIs
under merchant-granted scopes.

## 2. Access control

**Staff access to personal data is limited to the single administrator.** No
contractors, analysts, or third parties have accounts on Render, the database, or
any system holding merchant customer data.

Controls:

- Production database credentials exist only as the `DATABASE_URL` environment
  variable in Render. They are not committed to source control, not stored on
  local disk, and not shared.
- The database is not exposed publicly; it is reached through Render's private
  network by the app service.
- Direct database access is used only to diagnose a specific reported fault, not
  for routine work or exploratory querying.
- Shopify API access uses per-store offline tokens held in the database. Tokens
  are never logged; logging records token *presence and length*, never values.
- If anyone else is ever granted access, this document must be updated first, and
  access must be scoped to the minimum needed and revoked when the work ends.

**Password and account requirements** for every account that can reach personal
data (Render, GitHub, Shopify Partner, the domain registrar, and the email
account used for account recovery):

- Unique passwords per service, minimum 16 characters, generated and stored in a
  password manager. No reuse across services.
- Two-factor authentication enabled on every account that supports it.
- No shared logins.
- Credentials rotated if a compromise is suspected, and immediately on any
  suspected exposure of `SHOPIFY_API_SECRET`, `DATABASE_URL`, or
  `LAUNCH_DIAGNOSTICS_TOKEN`.

## 3. Data loss prevention

**Preventing loss of data:**

- Render managed PostgreSQL performs automated daily backups with
  point-in-time recovery. Backups are encrypted at rest by Render.
- Application data is never the sole copy of merchant data — orders, customers,
  and products originate in Shopify and can be re-synced from the Admin API if
  local data is lost.
- Schema changes are applied through Prisma migrations held in version control,
  so the schema can be rebuilt from source.

**Preventing leakage of data:**

- All traffic is served over TLS; the app is HTTPS-only.
- Every `/api` route requires a verified Shopify session token. There is no
  cookie or query-parameter authentication fallback.
- No route outside `/api` returns merchant store data. Deployment diagnostics at
  `/launch/*` require a shared secret and return 404 without it.
- Personal data is not sent to any third party. There are no analytics,
  advertising, or data-broker integrations.
- Logs record identifiers, status codes, and durations — not customer contact
  details or access tokens.
- Merchant data is never copied to local machines for development. Development
  uses a separate database, never the production one.

## 4. Incident response

An incident is any suspected unauthorised access to merchant or customer data,
any credential exposure, or any vulnerability that could allow either.

**Reporting:** security reports go to abhimanyu@vedasuite.in, as published in
`SECURITY.md`. Reports are acknowledged within 2 business days.

**Response steps, in order:**

1. **Contain** — revoke or rotate exposed credentials
   (`SHOPIFY_API_SECRET`, `DATABASE_URL`, `LAUNCH_DIAGNOSTICS_TOKEN`), and take
   the affected route or service offline if exposure is ongoing.
2. **Assess** — determine what data was reachable, for how long, and for which
   shops, using Render request logs and structured application event logs.
3. **Fix** — patch and deploy; verify against production that the exposure is
   closed.
4. **Notify** — if merchant or customer personal data was accessed by an
   unauthorised party, notify affected merchants and Shopify Partner support
   without undue delay and within 72 hours of becoming aware, including what
   happened, what data was involved, and what was done about it.
5. **Record** — log the incident, root cause, and fix in `docs/incidents/`.

Rotating `SHOPIFY_API_SECRET` invalidates session-token verification for all
stores until the new value is deployed, so it is rotated deliberately, not
reflexively — but it *is* rotated whenever exposure is plausible.

## 5. Retention

**Retention period: personal data is retained for no longer than 90 days after a
store uninstalls.**

- While the app is installed, merchant and customer data is retained because the
  app's function (fraud history, refund-behaviour trends, competitor tracking)
  depends on historical records.
- On `shop/redact` — which Shopify normally sends about 48 hours after an
  uninstall — all store data is deleted: orders, customers, fraud signals,
  competitor data, price history, profit data, subscription, and the store
  record. This is a single transaction in `privacyService.ts`.
- On `customers/redact`, the identified customer's records are removed.
- `customers/data_request` returns the data held for the identified customer.
- **Backstop sweep.** A scheduled job runs every 24 hours and deletes all data
  for any store whose `uninstalledAt` is older than the retention period, using
  the same deletion path as `shop/redact`. This bounds retention even if a
  redact webhook is never delivered or fails permanently. Implemented in
  `dataRetentionService.ts`; the period is set by `DATA_RETENTION_DAYS`
  (default 90). A reinstall clears `uninstalledAt`, so active installations are
  never affected.

## 6. Review

This document is reviewed at least annually, and whenever: someone is granted
access to a system holding personal data, a new subprocessor is introduced, the
data collected changes, or an incident occurs.

## Known gaps

Tracked honestly so the declaration stays accurate:

- **No automated alerting** on repeated auth or webhook failures; detection
  currently depends on reviewing Render logs.
- **No independent security audit.** The "Audits and certifications" field in the
  Partner Dashboard is intentionally left blank.

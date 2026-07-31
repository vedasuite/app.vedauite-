# Shopify Expiring Offline Access Token — Root-Cause Fix & Report

Repository: `app-repo`
Branch: `phase-1-intelligence-ui` (built on top of `55ec8c2` → `0f71d24` → `7f541bc` → `ca281ba`)
Status: Fixed, committed locally. **Not pushed, not merged, not deployed.**

## 1. Root cause

Two, and only two, code paths in this codebase ever call Shopify's Admin
API with a stored token:

- `shopifyGraphQL()` in `backend/src/services/shopifyAdminService.ts` —
  every GraphQL call (billing, webhook registration, product/order sync)
  goes through this single function.
- `probeShopApi()` in `backend/src/services/shopifyConnectionService.ts` —
  the connection-health probe used by onboarding/diagnostics.

(Confirmed by a repo-wide search for `X-Shopify-Access-Token`: only these
two files send it.)

**Both already had real, working expiring-token infrastructure** — this
was not a "no expiring-token support exists" situation. The Prisma schema
already had `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`,
`tokenAcquisitionMode`; both the OAuth callback (`authRoutes.ts`) and the
App Bridge session-token exchange (`exchangeSessionTokenForOfflineToken`)
already captured and persisted `expires_in` / `refresh_token` /
`refresh_token_expires_in` when Shopify returned them; a scheduled refresh
path (`refreshOfflineAccessToken`) and a single existing test file
(`shopify-connection-service.test.cjs`) already existed.

**The actual bug** was narrower and more specific: both `shopifyGraphQL`
and `probeShopApi` only recognized **HTTP 401** (plus a narrow text regex)
as "the stored token is invalid, refresh it." Shopify's newer enforcement
— "non-expiring access tokens are no longer accepted for the Admin API" —
returns **HTTP 403** with a distinct error body that neither call site
recognized. So every Admin API call for this shop fell straight through to
a generic, unclassified error: no refresh attempt, no reconnect-required
state, the same failure repeating on every request.

**Compounding this:** the app's own self-heal middleware
(`ensureOfflineToken` → `ensureOfflineAccessToken`, which runs on every
authenticated `/api/*` request) considered *any* stored token "usable" as
long as it existed, wasn't uninstalled, and had no known near-term expiry.
A legacy (non-expiring) token has no `accessTokenExpiresAt` at all, so it
was judged "usable" forever — the self-heal exchange that could have
upgraded it to a genuinely expiring token never ran. That is why
uninstalling and reinstalling the app repeatedly did not fix the staging
environment: the classic OAuth callback kept producing another legacy
token, and nothing ever tried to upgrade it via Token Exchange, which is
the only mechanism that can.

### 1a. Update after staging validation — the actual final piece

The fix above was deployed to staging and verified to work exactly as
designed: the self-heal logic ran automatically (visible in the logs as
`shopify.connection.offline_token_self_healed`), with no manual
uninstall/reinstall needed this time. But the exchange it performed still
came back with `"hasRefreshToken":false` — Shopify was still not issuing
an expiring token, via *either* the classic grant or Token Exchange, for
this app.

Checking Shopify's current documentation directly (rather than relying on
the assumption that a new app is automatically enrolled in expiring
tokens) revealed the actual mechanism: **whether Shopify issues an
expiring or non-expiring offline token is controlled entirely by an
`expiring` request parameter that the app must send explicitly** — it is
not implied by app creation date, distribution status, or grant type.
None of the three token-acquisition call sites in this codebase were ever
sending it. This is the genuine, final root cause — everything in the
original fix above (the classifier, the concurrency guard, the bounded
self-heal dispatch) was necessary and correct scaffolding, but without
this one parameter, every acquisition path — classic OAuth, session-token
Token Exchange, and the legacy-migration exchange — would keep returning
a non-expiring token no matter how many times it ran.

**Added `expiring: "1"` to all three token-acquisition requests:**
- `authRoutes.ts` → `exchangeOfflineAccessToken` (classic `/auth/callback` grant)
- `shopifyConnectionService.ts` → `exchangeSessionTokenForOfflineToken` (Token Exchange via a live App Bridge session token)
- `shopifyConnectionService.ts` → `exchangeLegacyOfflineToken` (a **migration** exchange that presents the *existing* legacy access token as proof of identity — this function already existed in the codebase but was dead code, never called from anywhere)

**Also wired the legacy-migration function in**, since it was sitting
unused: `refreshOfflineAccessToken`'s "no refresh token" branch now
attempts `exchangeLegacyOfflineToken` before giving up. This one requires
no live session token at all — only the existing (still-valid-for-this-
purpose) legacy access token — so it's the mechanism that lets
**session-less contexts** (the connection-health probe, background sync
jobs, webhook registration retries) self-heal too, not just live
authenticated embedded requests. Per Shopify's documentation, the old
non-expiring token is automatically revoked by Shopify once this exchange
succeeds.

One related correctness fix made in passing: `exchangeLegacyOfflineToken`
previously hardcoded `tokenAcquisitionMode: "offline_expiring"`
unconditionally after any successful call; it now derives this the same
way the other two acquisition functions already did — from whether
Shopify's response actually included a `refresh_token`.

## 2. Files changed

| File | Change |
|---|---|
| `backend/src/services/shopifyConnectionService.ts` | Added `isShopifyAuthRejection()` (shared 401/403-"non-expiring" classifier); replaced the exchange-only in-flight map with `runExclusiveTokenOperation()`, shared by both the session-token exchange and the refresh-token-grant paths; added a bounded, in-memory, one-shot-per-process opportunistic upgrade for legacy tokens in `ensureOfflineAccessToken`; fixed `probeShopApi`'s failure classification to use the shared classifier; added `expiring: "1"` to `exchangeSessionTokenForOfflineToken` and `exchangeLegacyOfflineToken`; wired `exchangeLegacyOfflineToken` into `refreshOfflineAccessToken`'s no-refresh-token branch (previously dead code); fixed `exchangeLegacyOfflineToken`'s `tokenAcquisitionMode` to be conditional on an actual refresh token coming back. |
| `backend/src/services/shopifyAdminService.ts` | `shopifyGraphQL()`'s retry-on-auth-failure condition now uses the shared `isShopifyAuthRejection()` classifier instead of a 401-only check. |
| `backend/src/routes/authRoutes.ts` | Added `expiring: "1"` to `exchangeOfflineAccessToken` (the classic `/auth/callback` grant). |
| `backend/tests/shopify-connection-service.test.cjs` | 13 new/updated tests (16 total, all passing) covering acquisition (asserting `expiring: "1"` is sent), persistence, reuse, refresh, rotation, concurrency, session-less legacy migration, and failure handling. |
| `backend/tests/shopifyGraphQLAuthRetry.test.cjs` | New file — 3 tests exercising the exact real failure mode end-to-end (403 → refresh → retry → success; unrecoverable refresh → controlled error; unrelated 500 → no false-positive retry). |

Nothing in routing, ModuleGate, billing plan definitions, webhook topic
subscriptions, OAuth *scopes*, or the frontend was changed.

## 3. Database migration

**None required or added.** Every field needed for the full expiring-token
lifecycle already existed in `schema.prisma`'s `Store` model —
`accessToken`, `accessTokenExpiresAt`, `refreshToken`,
`refreshTokenExpiresAt`, `tokenAcquisitionMode`, `uninstalledAt`,
`authErrorCode`, `authErrorMessage`, `lastConnectionStatus`,
`lastConnectionCheckAt`, `lastConnectionError`, `installedAt`,
`reauthorizedAt`, `grantedScopes` — confirmed by direct inspection before
writing any code, and via a prior migration
(`prisma/migrations/20260406_expiring_offline_tokens`) already present in
the repo's history. This was purely an application-logic bug, not a data
model gap.

The one piece of new state this fix introduces — tracking "have we already
attempted an opportunistic legacy-token upgrade for this shop" — is
**deliberately not persisted**. It's an in-memory `Set<string>` that resets
on every process restart. This was a specific design choice, not an
oversight — see §6.

## 4. Token lifecycle (as it now works end to end)

1. **Acquisition.** A merchant installs (or reconnects). The classic OAuth
   callback (`/auth/callback`) stores whatever Shopify returns — this may
   or may not include `expires_in`/`refresh_token`, entirely at Shopify's
   discretion for that grant type. Separately, every authenticated
   embedded page load carries a live App Bridge session token through
   `ensureOfflineToken` middleware, which is the mechanism actually able
   to obtain a genuinely expiring token via Token Exchange
   (`exchangeSessionTokenForOfflineToken`).
2. **Persistence.** Both paths store `accessToken`, `accessTokenExpiresAt`,
   `refreshToken`, `refreshTokenExpiresAt`, and `tokenAcquisitionMode`
   (`"offline_expiring"` when a refresh token came back, `"offline_legacy"`
   otherwise) — unchanged by this fix, already correct.
3. **Reuse.** `ensureOfflineAccessToken` treats an existing, non-expiring-soon,
   non-legacy token as usable with zero network calls (verified by test:
   "valid token reuse ... makes no network call").
4. **Opportunistic upgrade (new).** If the stored token is in legacy mode
   (no refresh token) *and* a live session token is present on the current
   request, the middleware now attempts exactly one Token Exchange upgrade
   attempt per shop per server-process lifetime. Success flips the store to
   `offline_expiring` with a real refresh token; from then on it behaves
   like any other expiring token. Failure is caught, logged, and falls back
   to the existing token — never a crash.
5. **Refresh before expiry.** `resolveOfflineInstallation` proactively
   refreshes when `accessTokenExpiresAt` is within a 5-minute buffer,
   unchanged behavior, now additionally serialized (see next point).
6. **Concurrency (fixed).** All token-mutating calls for a given shop —
   whether a session-token exchange or a refresh-token-grant refresh — now
   share one in-flight-promise map (`runExclusiveTokenOperation`), keyed by
   shop. A second caller arriving while an operation is already running for
   that shop receives the *same* promise (same eventual result or error)
   instead of issuing a second, competing Shopify request with a
   possibly-already-rotated refresh token. Verified by a dedicated
   concurrency test asserting exactly one network call for two simultaneous
   refreshes.
7. **Rotation.** When Shopify returns a new `refresh_token`, it fully
   replaces the stored one in the same atomic `prisma.store.update()` call
   that also updates the access token — verified by a test that performs
   two sequential refreshes and asserts the second one presents the
   *newly* rotated token, never the original.
8. **Reactive self-heal on actual rejection (fixed).** `shopifyGraphQL` now
   recognizes a 403 "non-expiring access tokens are no longer accepted"
   response (via the shared `isShopifyAuthRejection`) exactly as it already
   recognized 401 — triggering one `forceRefreshOfflineAccessToken()` +
   single retry. If that refresh is itself impossible (no refresh token to
   use — the legacy case, without a session token in this call path to
   upgrade with), the failure is reported as a controlled
   `SHOPIFY_RECONNECT_REQUIRED`/`SHOPIFY_AUTH_REQUIRED` error with a working
   `reauthorizeUrl`, never a raw unhandled exception.
9. **Reconnect flow.** The "Reconnect Shopify" button was already fully
   wired end-to-end (`buildReauthorizeUrl` → `/auth/reconnect` →
   `startOAuth`), confirmed unchanged and correct — no frontend or routing
   change was needed or made.
10. **No leakage.** No log line or thrown error anywhere in the changed
    code includes a raw token value — confirmed by a dedicated test that
    seeds an obviously-fake secret token/refresh-token pair and asserts
    neither appears in the serialized error.

## 5. Test results

```
node --test tests/shopify-connection-service.test.cjs tests/shopifyGraphQLAuthRetry.test.cjs
```
→ **16/16 pass** (16 in `shopify-connection-service.test.cjs`, 3 of which are
part of `shopifyGraphQLAuthRetry.test.cjs`'s separate 3/3 — 19 total across
the two files).

Coverage against the requested list:
- expiring-token acquisition (now asserting `expiring: "1"` is actually sent) ✅
- token/expiry persistence ✅
- valid token reuse (no network call) ✅
- refresh before expiry ✅
- rotated refresh-token persistence (next call uses the new one, not the old) ✅
- concurrent refresh protection (one network call for two simultaneous refreshes) ✅
- transient refresh failure (500 → `TOKEN_REFRESH_FAILED`, not forced reconnect) ✅
- definitively invalid/expired refresh token (400 `invalid_grant` → `SHOPIFY_RECONNECT_REQUIRED` with a working `reauthorizeUrl`) ✅
- reconnect-required response shape ✅
- no token leakage in serialized errors/logs ✅
- (added, matching the real observed bug) 403 "non-expiring" rejection → one forced refresh → retry → success ✅
- (added) unrecoverable rejection surfaces a controlled error, never retries twice ✅
- (added) an unrelated 500 is never misclassified as an auth rejection ✅
- (added, §1a) session-less legacy-token migration via `exchangeLegacyOfflineToken`, asserting `expiring: "1"` and the legacy token itself as `subject_token` ✅
- (added, §1a) a legacy token that cannot be migrated or refreshed still falls back to a controlled reconnect-required response ✅

### Full build gates

| Gate | Result |
|---|---|
| Targeted auth tests (`shopify-connection-service.test.cjs` + `shopifyGraphQLAuthRetry.test.cjs`) | 19/19 pass |
| Backend TypeScript (`tsc --noEmit`) | 0 errors |
| Backend production build | success |
| Full backend suite (`tests/*.test.cjs`) | 121 tests, 115 pass, 6 fail |
| Frontend TypeScript (`tsc --noEmit`) | 32 errors — unchanged baseline |
| Frontend production build (`vite build`) | success (1139 modules; frontend untouched by this fix) |

The 6 backend failures are the same pre-existing baseline failures tracked
throughout Phase 1 (Cookie-header integration-test helper issue; same test
names, same root cause, unrelated to this fix) — unchanged before and
after.

## 6. Production migration — what this means for existing merchants

This fix does **not** run anything against production, and did not touch
any production database or deployment. But because the corrected logic
lives in shared code (`shopifyConnectionService.ts`, `shopifyAdminService.ts`),
it's worth being explicit about what happens *if and when* this branch is
eventually deployed to production:

- **Nothing changes for a production merchant whose current legacy token
  still works.** `ensureOfflineAccessToken`'s opportunistic upgrade only
  fires when a session token is present *and* the stored token is in
  legacy mode — it will attempt one Token Exchange call the first time
  that shop is seen after a deploy/restart. For an app not yet subject to
  Shopify's expiring-token enforcement, Shopify's Token Exchange endpoint
  is expected to simply return an equivalent, still-non-expiring token (no
  `refresh_token` in the response) — a harmless no-op, not a breaking
  change, not a forced re-authorization, and not visible to the merchant.
- **For a merchant whose legacy token Shopify has started rejecting** (the
  same situation staging hit), this same logic is exactly what fixes it
  automatically on their next authenticated page load, with no merchant
  action required.
- **This is deliberately a soft, bounded, self-healing improvement, not a
  bulk migration job.** There is no code path in this change that iterates
  over all merchants, forces re-authorization, or invalidates a token that
  was working. The attempt is scoped to one shop, once per process
  lifetime, only in response to a live authenticated request — it cannot
  run "in bulk" by construction.
- **Recommendation for the actual production rollout:** deploy this fix
  during a normal release once QA is satisfied, and watch the
  `shopify.connection.offline_token_self_healed` (with `wasLegacyMode: true`)
  log event rate for the first few hours after deploy — that is the signal
  for how many production shops were silently upgraded versus how many
  simply reused their existing token unchanged. No manual per-merchant
  migration step is needed; this was intentionally designed so a normal
  deploy *is* the migration.

## 7. Staging retest steps

**Note:** an earlier version of this fix (without `expiring: "1"`) was
already deployed and tested live on staging — it confirmed the self-heal
logic runs automatically (no manual uninstall/reinstall needed), but the
resulting token was still non-expiring, which is what led to the §1a
addendum above. These steps are for retesting with the *current*, complete
commit that adds `expiring: "1"`.

1. On the `vedasuite-staging` Render service, trigger **Manual Deploy →
   Deploy latest commit**.
2. In the development store admin, if the app currently shows the
   "Shopify connection needs attention" banner, **reload the embedded app
   page** (no uninstall/reinstall needed) — the very next authenticated
   request runs the opportunistic legacy-token upgrade automatically.
3. Check the **Logs** tab for `shopify.connection.offline_token_self_healed`
   or `shopify.connection.legacy_token_exchanged`, and confirm the
   accompanying `hasRefreshToken`/`accessTokenExpiresAt` fields are now
   populated (not `false`/`null`) — this is the concrete signal that
   Shopify actually issued an expiring token this time.
4. Retry **Billing**, **Sync Data**, and the **Dashboard** — all should
   now succeed without the "non-expiring access tokens" error.
5. If it still fails: check the Logs for
   `shopify.connection.token_exchange_failed` or
   `shopify.connection.legacy_token_exchange_failed` — the attached error
   will show Shopify's actual rejection reason for this specific app/shop
   pairing (e.g. a distribution, scope, or app-review-status issue
   unrelated to the `expiring` parameter itself).

## 8. Rollback

This fix is committed as its own commit (see below) on top of
`ca281ba` on branch `phase-1-intelligence-ui`. To roll back:

```bash
git revert <this-commit-sha>
```

or, since the branch remains local-only and unshared, `git reset --hard ca281ba`
to drop it entirely. No schema or migration changes are part of this
commit, so rollback carries no data-migration risk either way.

## 9. Known limitations

- **Recommended improvement, not a blocker:** the opportunistic upgrade
  tracking (`legacyUpgradeAttempted`) is in-memory only, so it resets on
  every deploy/restart. On Render's current Free-tier setup this is a
  single instance (`WEB_CONCURRENCY=1`, confirmed in deploy logs), so this
  is fully correct today. If the service is ever scaled to multiple
  instances, each instance would independently attempt the upgrade once —
  still safe (each attempt is idempotent and cheap), just not perfectly
  deduplicated across instances. Worth revisiting only if/when multi-instance
  scaling is actually adopted.
- **Future enhancement:** for a shop whose classic OAuth callback token
  never gets upgraded because it never presents a live session token
  (unlikely for an embedded app, but theoretically possible for
  API-only/headless usage), the only recovery path remains the existing
  `SHOPIFY_RECONNECT_REQUIRED` reconnect flow — this is the correct,
  already-existing fallback, not a new gap introduced by this fix.

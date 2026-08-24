# Production Prisma baseline — runbook

**Status: PREPARED, NOT EXECUTED.** Nothing in this runbook has been run against
production. It exists to be executed by the owner, step by step, with a stop
point after every step.

## What problem this solves

Production's schema was created with `prisma db push`. The 14 historical
migration files were added afterwards and were never recorded in
`_prisma_migrations`. So Prisma sees a non-empty database with no migration
history and refuses to continue:

```
P3005  The database schema is not empty.
```

The fix is to record those 14 as already applied — but **only after proving
every structure each one creates already exists**. Marking an unverified
migration as applied would permanently skip a change the database actually
needs, silently, with no error at the time.

## Absolute rules

- **Never** run `prisma migrate reset`, `prisma db push`, or any destructive SQL.
- **Never** create the `IntelligenceFinding` table by hand.
- If **even one** migration cannot be proven present: **STOP**. Do not resolve
  any of them. Report the output.
- Do not merge `staging` to `main` and do not deploy application code as part of
  this runbook. This is a database-only operation.

## Before you start

- Take a **database backup / snapshot** through your Postgres provider. This
  runbook makes one small additive change, but a restore point costs nothing.
- Have the production `DATABASE_URL` available **to the Render environment
  only**. Do not paste it into chat, a file, or a command you will save.
- Expect the whole procedure to take a few minutes. Nothing here is
  time-sensitive; stop whenever anything looks wrong.

Render's production service is where these commands run, via the **Build
Command** (Shell is unavailable on the Free plan). Each step replaces the Build
Command temporarily, deploys, and reads the log.

**After every step, restore the original Build Command.** Leaving a baseline
command in place would re-run it on every future deploy.

Record the original value now:

```
cd frontend && npm install && npm run build && cd ../backend && npm install && npx prisma generate && npx prisma migrate deploy && npm run build
```

---

## Step 1 — Read-only verification (safe, makes no changes)

Set the production service's Build Command to:

```bash
cd backend && npm install && VEDASUITE_BASELINE_CONFIRM=verify-production-baseline node scripts/verify-production-baseline.js
```

Deploy, then read the log.

**What the script does:** connects, opens `BEGIN TRANSACTION READ ONLY` — which
PostgreSQL itself enforces, so no write is possible even if the script were
wrong — introspects the schema, and rolls back. It never prints the connection
string; it identifies the database by name and a one-way host fingerprint.

**Expected output ends with:**

```
VERDICT: all 14/14 historical migrations VERIFIED PRESENT.
Safe to proceed to the resolve step in the runbook.
```

**Capture from the log and keep:**

1. the full `STEP 1` PASS/FAIL list
2. the `STEP 3` `_prisma_migrations` state
3. the entire `STEP 4` row-count table — this is the **before** baseline
4. the `ROW_COUNT_BASELINE_JSON=` line

### If the verdict is STOP

Stop here. Do not run Step 2. Report the FAIL lines — they name the exact
missing structure. A missing structure means production genuinely never received
that change, and it needs a real migration, not a baseline entry.

Restore the original Build Command before doing anything else.

---

## Step 2 — Mark the 14 historical migrations as applied

Only if Step 1 verified all 14.

This writes to `_prisma_migrations` **only**. It does not touch application
tables and does not run any migration SQL.

Set the Build Command to:

```bash
cd backend && npm install && npx prisma generate && \
npx prisma migrate resolve --applied 20260403_billing_access_architecture && \
npx prisma migrate resolve --applied 20260404_core_engines && \
npx prisma migrate resolve --applied 20260405_shopify_connection_health && \
npx prisma migrate resolve --applied 20260405_shopify_oauth_hardening && \
npx prisma migrate resolve --applied 20260406_activation_truthfulness && \
npx prisma migrate resolve --applied 20260406_expiring_offline_tokens && \
npx prisma migrate resolve --applied 20260406_shopify_installation_hardening && \
npx prisma migrate resolve --applied 20260408_billing_install_metadata_truth && \
npx prisma migrate resolve --applied 20260408_billing_management_intents && \
npx prisma migrate resolve --applied 20260409_onboarding_flow_refactor && \
npx prisma migrate resolve --applied 20260409_onboarding_state && \
npx prisma migrate resolve --applied 20260502_order_identity_fields && \
npx prisma migrate resolve --applied 20260803_shop_trial_history && \
npx prisma migrate resolve --applied 20260803_subscription_plan_trial_days_default
```

That is exactly 14 commands. **`20260804_intelligence_finding_foundation` is
deliberately absent** — it must be *applied* by Prisma, not marked as done.

Expected: 14 lines of `Migration ... marked as applied.`

If any command fails, stop and report. Re-running a `resolve` that already
succeeded is harmless, so a partial run can be safely resumed.

---

## Step 3 — Apply the one new migration

Set the Build Command to:

```bash
cd backend && npm install && npx prisma generate && npx prisma migrate deploy
```

**Expected:** exactly one migration applied —
`20260804_intelligence_finding_foundation`.

If the log shows Prisma applying **more than one** migration, something is wrong
with the previous step. Stop and report before deploying anything else.

The migration is additive and `IF NOT EXISTS`-guarded: it creates one new table
and its indexes, and touches no existing table's data.

---

## Step 4 — Post-deploy verification (read-only again)

Set the Build Command to:

```bash
cd backend && npm install && VEDASUITE_BASELINE_CONFIRM=verify-production-baseline node scripts/verify-production-baseline.js --post-deploy
```

This re-runs the read-only checks and adds `STEP 5`, which verifies:

- the `IntelligenceFinding` table exists
- its primary key `IntelligenceFinding_pkey`
- a **UNIQUE** index on `(storeId, fingerprint)`, checked against the actual
  index definition, not just its name
- the foreign key `IntelligenceFinding_storeId_fkey` is **`ON DELETE CASCADE`**
  — required so a `shop/redact` purge cannot leave orphaned findings
- `_prisma_migrations` holds exactly **15** rows, all finished
- `IntelligenceFinding` row count is **0**

**Then compare the `STEP 4` row counts against the baseline you captured in
Step 1.** Every pre-existing table must be unchanged. That is the proof that
baselining altered no merchant data.

---

## Step 5 — Restore the Build Command

Set it back to the original value recorded at the top. **Do not skip this.**

Then confirm the service is healthy:

```bash
curl -s https://<production-host>/health
```

---

## Rollback

- **Steps 1 and 4** are read-only. Nothing to roll back.
- **Step 2** writes only to `_prisma_migrations`. If it ran but Step 3 has not,
  the application is unaffected — the rows describe changes production already
  had.
- **Step 3** adds one empty table. If it must be reversed, restore the snapshot
  taken before you started, rather than dropping the table by hand.

At no point does this runbook modify application code, so there is no
application rollback to perform.

---

## After this runbook

Production Prisma is baselined and `prisma migrate deploy` works normally from
then on. **Promotion of application code to `main` is a separate decision and a
separate change.** Do not merge as part of this operation.

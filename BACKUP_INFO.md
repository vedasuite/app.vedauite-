# Backup — VedaSuite AI Shopify App

**This is the Shopify App Store–approved version as of this date. Do not edit
this branch or archive. To build new features, branch off `main`/`develop`
instead, never off this backup.**

## Snapshot details

- **Date of backup:** 2026-07-30
- **Commit hash:** `ccfbfbc3b8e6199a59b1dd4a024fb7d40c3df4d9`
- **Backed up from branch:** `main`
- **Backup branch:** `approved-backup-app1`
- **Backup tag:** `approved-backup-app1-v1` (points at the commit above, without this manifest)

## Shopify app identifiers

- **App name:** VedaSuite AI
- **Handle:** vedasuite-ai
- **client_id:** `b7789c5899a579e9bc9e950a9bbd6547`
- **API version:** `2026-01`
- **Scopes:** `read_products,read_orders,write_orders,read_customers`
- **Application URL:** https://app.vedasuite.in

## Restore

- **From git:** `git checkout approved-backup-app1-v1` (detached at the exact approved commit), or `git checkout approved-backup-app1` for the branch that also carries this manifest.
- **From the zip archive:** extract `approved-backup-app1-2026-07-30.zip` into an empty directory; it contains the full tracked working tree at the commit above. Reinstall dependencies (`npm install` in `backend/` and `frontend/`) since `node_modules` is intentionally excluded.

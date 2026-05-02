# Shopify Approval Audit Report

Generated: 2026-04-15

## Scope Of Audit

This audit focused on Shopify approval readiness, not feature expansion. The review covered:

- embedded app behavior
- install and reconnect flow
- billing truthfulness
- privacy and protected customer data handling
- webhook obligations
- merchant clarity and reviewer trust

## Root Risks Found

1. The app config still requested `write_products`, even though the current reviewer-facing product flow does not publish prices back to Shopify.
2. Shopper email labels were still exposed too directly in fraud and credit-scoring payloads, which is avoidable for reviewer-facing UI.
3. Existing launch docs were useful but partially outdated for current approval scope expectations.
4. The launch audit endpoint did not explicitly flag scope minimization, which makes pre-submit verification weaker than it should be.

## Code And Config Fixes Applied

- Removed `write_products` from [`shopify.app.toml`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/shopify.app.toml)
- Removed the same unused default scope from [`backend/src/config/env.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/config/env.ts)
- Removed the unused Shopify product price publishing path from [`backend/src/services/shopifyAdminService.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/shopifyAdminService.ts)
- Added a shared identity-masking helper in [`backend/src/lib/maskCustomerIdentity.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/lib/maskCustomerIdentity.ts)
- Applied masking to fraud outputs in [`backend/src/services/fraudService.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/fraudService.ts)
- Applied masking to credit-scoring outputs in [`backend/src/services/creditScoreService.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/services/creditScoreService.ts)
- Added an explicit scope-minimization check to [`backend/src/routes/launchRoutes.ts`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/src/routes/launchRoutes.ts)
- Updated audit coverage in [`backend/tests/launch-smoke.test.cjs`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/launch-smoke.test.cjs)
- Added masking regression coverage in [`backend/tests/privacy-safety.test.cjs`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/backend/tests/privacy-safety.test.cjs)

## Documentation Added Or Updated

- Added [`docs/launch/SHOPIFY_APPROVAL_PRE_SUBMISSION_CHECKLIST.md`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/docs/launch/SHOPIFY_APPROVAL_PRE_SUBMISSION_CHECKLIST.md)
- Added [`docs/launch/SHOPIFY_REVIEWER_TEST_GUIDE.md`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/docs/launch/SHOPIFY_REVIEWER_TEST_GUIDE.md)
- Updated [`docs/launch/SHOPIFY_REVIEWER_RUNBOOK.md`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/docs/launch/SHOPIFY_REVIEWER_RUNBOOK.md)
- Updated [`docs/launch/PARTNER_DASHBOARD_SUBMISSION_CHECKLIST.md`](/Users/Abhimanyu/OneDrive/Desktop/untitled%20folder/vedasuite-shopify-app/app-repo/docs/launch/PARTNER_DASHBOARD_SUBMISSION_CHECKLIST.md)

## Approval Notes

- `write_orders` remains intentional because fraud workflows can add order review tags.
- Compliance webhooks are present and HMAC verification is enforced in the backend webhook router.
- Public privacy, support, and terms routes already exist and remain part of the submission package.

## Remaining Manual Work Before Submission

1. Confirm the Partner Dashboard protected customer data declaration matches the app’s actual data use.
2. Confirm Partner Dashboard scopes exactly match the repo scopes after the scope reduction.
3. Run the reviewer flow on a clean Shopify store and capture screenshots or a short recording.
4. Confirm production billing test mode is disabled at deploy time.

# Shopify Review Guardrails

These guardrails keep VedaSuite product expansion inside Shopify review-safe
patterns while we deepen fraud, trust, pricing, and competitor intelligence.

## Protected Customer Data

- request only the minimum Shopify scopes required
- keep customer-facing signals tied to merchant workflows inside the embedded app
- complete protected customer data declarations in Partner Dashboard before submit

## Shared Fraud Intelligence

- keep the feature merchant opt-in
- limit sharing to anonymized or pseudonymized fraud indicators
- do not expose raw cross-merchant customer contact data in the product
- explain the feature clearly in privacy policy and reviewer notes

## Billing and App Review

- keep billing on Shopify Billing only
- keep plan gating consistent with in-app plan descriptions
- ensure app URLs, redirect URLs, and webhook URLs use the production domain

## Webhooks and Compliance

- keep `app/uninstalled` active
- keep `customers/data_request`, `customers/redact`, and `shop/redact` active
- keep HMAC verification enforced for webhook endpoints

## External Intelligence Connectors

- where official external APIs are not yet integrated, present those signals as
  monitoring aids rather than claims of official direct integrations
- avoid misleading claims in listing copy or reviewer materials

## AI Decisioning

- keep sensitive automations approval-led unless the merchant explicitly enables
  tighter controls
- maintain explainability for fraud, trust, pricing, and competitor decisions
- do not make unsupported guarantees about fraud prevention or financial outcomes

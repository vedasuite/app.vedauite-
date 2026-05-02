# AI Pricing Engine Refactor Report

## Old contradictions found
- The page showed exact projected gain numbers while nearby sections still said profit or competitor readiness was incomplete.
- Response mode could say competitor data was still missing while live pricing recommendation cards were already visible.
- Advanced mode gating, diagnostics, and recommendation workflow were mixed together, which made the page feel like stacked concepts instead of one operational path.
- Empty or low-information side sections still occupied large layout areas, which created blank or weak panels.

## New unified pricing state model
- Backend now returns a single `pricingState` object with:
  - `primaryState`
  - `setupStatus`
  - `pricingStatus`
  - `competitorDependency`
  - `profitModelStatus`
  - `recommendationCount`
  - `prioritizedRecommendationCount`
  - `projectedGainStatus`
  - `projectedGainValue`
  - `responseMode`
  - `lastSuccessfulRunAt`
  - `title`
  - `description`
  - `nextAction`
- The page uses this state for banner tone, summary cards, recommendation empty states, and final refresh timestamp.

## Projected gain logic
- Exact gain is shown only when a value exists.
- If gain is coming from baseline pricing logic rather than full profit outputs, the UI labels it as `Estimated gain`.
- If pricing/profit readiness is not sufficient, gain is shown as `Not available` instead of a misleading hard number.

## Recommendation ranking logic
- Recommendations are now normalized and ranked in the backend.
- Each recommendation includes:
  - current price
  - recommended price
  - action label
  - expected impact
  - confidence
  - data basis
  - short reasoning
  - supporting explanation
  - inputs used
  - merchant action note

## Layout fixes
- The page now follows one primary workflow:
  1. Header + refresh
  2. Primary pricing state
  3. Compact summary cards
  4. Priority recommendations
  5. Diagnostics
  6. Pricing modes
  7. Plan-gated capability summary
- Large low-value side stacks were removed in favor of fewer, denser workflow sections.

## Plan-gating consolidation changes
- Upgrade messaging now sits in one lower section instead of being scattered through the main recommendation flow.
- Main recommendation sections focus on what is available now.
- The billing CTA remains available through one `Manage plan` action.

## QA scenarios to verify
- Baseline-only recommendations available, competitor data missing
- Competitor-informed recommendations available
- No recommendations needed
- Profit model missing
- Profit model ready
- Processing state
- Failed state
- Empty diagnostic sections
- Growth plan versus Pro plan messaging

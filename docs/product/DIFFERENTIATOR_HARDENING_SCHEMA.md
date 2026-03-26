# Differentiator Hardening Schema Notes

This document captures the next durable schema upgrades for the VedaSuite
intelligence differentiators. The current implementation computes richer
explanations on top of the existing schema to avoid risky live migrations. The
fields below should be promoted into Prisma models when the team is ready to
run a migration.

## 1. Shared Fraud Intelligence Network

Recommended additions:

- `Store.sharedFraudNetworkMode`
  - `off | advisory | review_first`
- `FraudSignal.networkMatchCount`
- `FraudSignal.networkConfidence`
- `FraudSignal.reasonCodesJson`
- `FraudSignal.recommendedAction`
- `FraudSignal.automationPosture`

Why:

- makes repeat-match evidence queryable
- supports durable fraud automations
- lets the dashboard and fraud queue avoid recomputing explanations every load

## 2. Wardrobing Detection AI

Recommended additions:

- `Customer.wardrobingScore`
- `Customer.wardrobingLikelihood`
- `Customer.wardrobingReasonsJson`
- `Customer.wardrobingAutomationPosture`

Why:

- gives return-abuse decisions a durable data layer
- supports category-aware policy logic later
- reduces repeated derived scoring work

## 3. Shopper Credit Score As A Trust Layer

Recommended additions:

- `Customer.trustConfidence`
- `Customer.trustReasonsJson`
- `Customer.trustAutomationPosture`
- `Customer.trustSegment`

Why:

- makes trust policy automation explicit
- supports future refund, support, and fulfillment automations

## 4. Competitor Response Engine

Recommended additions:

- `CompetitorData.pressureScore`
- `CompetitorData.responsePlay`
- `CompetitorData.responseConfidence`
- `CompetitorData.responseReasonsJson`
- `CompetitorData.executionHint`

Why:

- preserves market-response recommendations historically
- enables reporting on which competitor moves triggered which playbooks

## 5. Unified Decision System

Recommended additions:

- new `DecisionCenterSnapshot` model
  - `storeId`
  - `module`
  - `title`
  - `severity`
  - `confidence`
  - `recommendedAction`
  - `automationPosture`
  - `explanationPointsJson`
  - `route`

Why:

- makes the decision center auditable
- supports weekly reporting and reviewer walkthroughs
- gives the product a durable operating history

## Suggested Migration Order

1. Fraud signal reason/confidence fields
2. Customer trust and wardrobing fields
3. Competitor response fields
4. Decision center snapshot model

## Migration Guidance

- add fields as nullable first
- backfill from existing derived logic
- switch UI reads over gradually
- only then make required fields strict if needed

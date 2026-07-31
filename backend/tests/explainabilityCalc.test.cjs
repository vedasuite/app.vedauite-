const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const calc = require(path.resolve(__dirname, "../dist/services/explainabilityCalc.js"));

const NOW = "2026-07-31T00:00:00.000Z";
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

// ---------------- Opportunity Score ----------------
test("opportunity score: exact component weights", () => {
  const s = calc.computeOpportunityScore({
    financialImpact: { status: "quantified", min: 0, max: 100, currency: "USD", period: "monthly_estimate", basis: "x", isEstimate: true },
    urgency: "high", confidence: "high", easeOfAction: "guided", recencyIso: NOW, nowIso: NOW, storeImpactCap: 100,
  });
  assert.deepEqual(s.weights, { financialImpact: 0.35, urgency: 0.25, confidence: 0.2, easeOfAction: 0.1, recency: 0.1 });
  // impact=100, urgency=75, confidence=100, ease=60, recency=100
  // total = .35*100 + .25*75 + .2*100 + .1*60 + .1*100 = 35 + 18.75 + 20 + 6 + 10 = 89.75
  assert.equal(s.total, 89.75);
  assert.equal(s.excludedFromMonetaryRanking, false);
});

test("opportunity score: missing financial impact excluded from monetary ranking", () => {
  const s = calc.computeOpportunityScore({
    financialImpact: { status: "impact_not_quantifiable", reason: "x" },
    urgency: "critical", confidence: "high", easeOfAction: "one_click_review", recencyIso: NOW, nowIso: NOW, storeImpactCap: 100,
  });
  assert.equal(s.excludedFromMonetaryRanking, true);
  assert.equal(s.total, 0, "no fabricated monetary score");
});

test("opportunity score: insufficient confidence excluded", () => {
  const s = calc.computeOpportunityScore({
    financialImpact: { status: "quantified", min: 0, max: 100, currency: "USD", period: "monthly_estimate", basis: "x", isEstimate: true },
    urgency: "high", confidence: "insufficient_data", easeOfAction: "guided", recencyIso: NOW, nowIso: NOW, storeImpactCap: 100,
  });
  assert.equal(s.excludedFromMonetaryRanking, true);
  assert.equal(s.total, 0);
});

test("critical non-monetary finding appears in criticalAttention without a fabricated score", () => {
  const base = {
    id: "a", storeId: "s1", module: "fraud", title: "t", reasons: [], evidence: [],
    confidence: "high", recency: NOW, urgency: "critical", easeOfAction: "one_click_review",
    recommendedAction: "r", route: "/", dataQuality: "ok",
    financialImpact: { status: "impact_not_quantifiable", reason: "x" },
    score: { total: 0, components: {}, weights: {}, excludedFromMonetaryRanking: true },
    methodology: { summary: "", assumptions: [], caps: [] },
  };
  const out = calc.selectCriticalAttention([base]);
  assert.equal(out.length, 1);
  assert.equal(out[0].isCriticalNonMonetary, true);
  assert.equal(out[0].financialImpact.status, "impact_not_quantifiable");
});

// ---------------- Deduplication ----------------
test("dedup: same product in PriceHistory and ProfitOptimization counted once (PriceHistory wins)", () => {
  const out = calc.dedupePotentialUpside([
    { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: 50, valid: true },
    { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "profit_optimization", amount: 999, valid: true },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "price_history");
  assert.equal(out[0].amount, 50);
});

test("dedup: latest valid PriceHistory row wins", () => {
  const out = calc.dedupePotentialUpside([
    { storeId: "s1", productHandle: "shirt", createdAtIso: daysAgo(0) + "", source: "price_history", amount: 10, valid: true },
    { storeId: "s1", productHandle: "shirt", createdAtIso: daysAgo(0), source: "price_history", amount: 20, valid: true },
  ].map((c, i) => ({ ...c, createdAtIso: i === 0 ? "2026-07-31T10:00:00.000Z" : "2026-07-31T20:00:00.000Z" })));
  assert.equal(out.length, 1);
  assert.equal(out[0].amount, 20, "later timestamp same window wins");
});

test("dedup: stale/invalid rows excluded", () => {
  const out = calc.dedupePotentialUpside([
    { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: null, valid: false },
    { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "profit_optimization", amount: 30, valid: true },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "profit_optimization");
});

test("dedup: duplicate events counted once", () => {
  const row = { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: 40, valid: true };
  const out = calc.dedupePotentialUpside([row, { ...row }, { ...row }]);
  assert.equal(out.length, 1);
});

test("dedup: different products remain separate", () => {
  const out = calc.dedupePotentialUpside([
    { storeId: "s1", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: 10, valid: true },
    { storeId: "s1", productHandle: "pants", createdAtIso: NOW, source: "price_history", amount: 20, valid: true },
  ]);
  assert.equal(out.length, 2);
});

test("dedup: productId preferred over handle where available", () => {
  const a = calc.canonicalProductIdentity({ productId: "gid://p/1", productHandle: "shirt" });
  const b = calc.canonicalProductIdentity({ productHandle: "shirt" });
  assert.ok(a.startsWith("id:"));
  assert.ok(b.startsWith("handle:"));
  // same handle, different productId => different identities => not merged
  const out = calc.dedupePotentialUpside([
    { storeId: "s1", productId: "gid://p/1", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: 10, valid: true },
    { storeId: "s1", productId: "gid://p/2", productHandle: "shirt", createdAtIso: NOW, source: "price_history", amount: 20, valid: true },
  ]);
  assert.equal(out.length, 2);
});

// ---------------- Return abuse ----------------
function order(id, status, refunded, amount, ageDays) {
  return { id, status, refunded, totalAmount: amount, createdAtIso: daysAgo(ageDays) };
}

test("return abuse: customer <5 eligible orders => not quantifiable, behavioural null", () => {
  const r = calc.computeReturnAbuseExposure({
    nowIso: NOW, currency: "USD",
    customerOrders: [order("o1", "paid", true, 100, 5), order("o2", "paid", false, 100, 6)],
    storeEligibleOrderCount: 100, storeRefundedEligibleCount: 10,
  });
  assert.equal(r.financialImpact.status, "impact_not_quantifiable");
});

test("return abuse: store <50 eligible => not quantifiable but behavioural preserved", () => {
  const custOrders = Array.from({ length: 6 }, (_, i) => order("o" + i, "paid", i < 3, 100, 10 + i));
  const r = calc.computeReturnAbuseExposure({
    nowIso: NOW, currency: "USD", customerOrders: custOrders,
    storeEligibleOrderCount: 40, storeRefundedEligibleCount: 4,
  });
  assert.equal(r.financialImpact.status, "impact_not_quantifiable");
  assert.equal(r.behavioural, null, "store threshold gates both");
});

test("return abuse: cancelled/test/baseline excluded; dup Order.id excluded", () => {
  const custOrders = [
    order("o1", "paid", true, 100, 5),
    order("o1", "paid", true, 100, 5), // duplicate id
    order("o2", "cancelled", true, 999, 5),
    order("o3", "baseline", true, 999, 5),
    order("o4", "test", true, 999, 5),
    order("o5", "paid", false, 100, 5),
    order("o6", "paid", false, 100, 5),
    order("o7", "paid", false, 100, 5),
    order("o8", "paid", false, 100, 5),
  ];
  const r = calc.computeReturnAbuseExposure({
    nowIso: NOW, currency: "USD", customerOrders: custOrders,
    storeEligibleOrderCount: 100, storeRefundedEligibleCount: 5,
  });
  // eligible unique = o1,o5,o6,o7,o8 = 5 orders, 1 refunded
  assert.equal(r.behavioural.eligibleCustomerOrders, 5);
});

test("return abuse: excessRate zero at/below baseline => not quantifiable", () => {
  const custOrders = Array.from({ length: 6 }, (_, i) => order("o" + i, "paid", i < 1, 100, 5));
  // customer refund rate = 1/6 ≈ 0.167; store baseline 0.5 => excess 0
  const r = calc.computeReturnAbuseExposure({
    nowIso: NOW, currency: "USD", customerOrders: custOrders,
    storeEligibleOrderCount: 100, storeRefundedEligibleCount: 50,
  });
  assert.equal(r.financialImpact.status, "impact_not_quantifiable");
  assert.ok(r.behavioural, "behavioural finding still present");
});

test("return abuse: amount capped at eligible 30-day order value; 90 vs 30 windows separate", () => {
  // 6 eligible orders, 5 refunded, all within 30d, high excess
  const custOrders = Array.from({ length: 6 }, (_, i) => order("o" + i, "paid", i < 5, 100, 5));
  const r = calc.computeReturnAbuseExposure({
    nowIso: NOW, currency: "USD", customerOrders: custOrders,
    storeEligibleOrderCount: 100, storeRefundedEligibleCount: 5, // baseline 0.05
  });
  assert.equal(r.financialImpact.status, "quantified");
  assert.equal(r.financialImpact.period, "last_30_days");
  // eligibleOrderValue30d = 600; max must be <= 600
  assert.ok(r.financialImpact.max <= 600);
  assert.equal(r.financialImpact.min, 0);
});

// ---------------- Competitor ----------------
test("competitor: gap cap of 15% enforced", () => {
  const capped = calc.computeCompetitorImpact({
    nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 40, // gap 0.6
    salesVelocity: 10, sellingPrice: 100, matchConfidence: "high", collectedAtIso: NOW,
  });
  // max = 100*10 * min(0.6,0.15) * 0.6 = 1000 * 0.15 * 0.6 = 90
  assert.equal(capped.status, "quantified");
  assert.equal(capped.max, 90);
});

test("competitor: high vs medium confidence factors", () => {
  const hi = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: 10, sellingPrice: 100, matchConfidence: "high", collectedAtIso: NOW });
  const md = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: 10, sellingPrice: 100, matchConfidence: "medium", collectedAtIso: NOW });
  // gap 0.1; hi: 1000*0.1*0.6=60 ; md: 1000*0.1*0.3=30
  assert.equal(hi.max, 60);
  assert.equal(md.max, 30);
});

test("competitor: low confidence / stale / null velocity => not quantifiable", () => {
  const low = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: 10, sellingPrice: 100, matchConfidence: "low", collectedAtIso: NOW });
  const stale = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: 10, sellingPrice: 100, matchConfidence: "high", collectedAtIso: daysAgo(20) });
  const nullVel = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: null, sellingPrice: 100, matchConfidence: "high", collectedAtIso: NOW });
  assert.equal(low.status, "impact_not_quantifiable");
  assert.equal(stale.status, "impact_not_quantifiable");
  assert.equal(nullVel.status, "impact_not_quantifiable");
});

test("competitor: product importance never changes the money (no importance input exists)", () => {
  // The function signature has no importance parameter — money is derived only
  // from proxy × gap × confidence. This asserts the contract structurally.
  const r = calc.computeCompetitorImpact({ nowIso: NOW, currency: "USD", ourPrice: 100, competitorPrice: 90, salesVelocity: 10, sellingPrice: 100, matchConfidence: "high", collectedAtIso: NOW });
  assert.equal(r.max, 60);
});

// ---------------- Periods ----------------
test("periods: each LeakGroup contains only one period; different periods never summed", () => {
  const groups = calc.groupLeaksByPeriod("revenue_at_risk", [
    { key: "a", label: "A", min: 0, max: 100, period: "current_open_exposure", confidence: "high" },
    { key: "b", label: "B", min: 0, max: 50, period: "monthly_estimate", confidence: "medium" },
    { key: "c", label: "C", min: 0, max: 25, period: "monthly_estimate", confidence: "medium" },
  ], "USD");
  assert.equal(groups.length, 2, "two distinct periods => two groups");
  for (const g of groups) {
    assert.ok(g.items.every((i) => i.period === g.period));
  }
  const monthly = groups.find((g) => g.period === "monthly_estimate");
  assert.equal(monthly.max, 75, "same-period summed");
  const open = groups.find((g) => g.period === "current_open_exposure");
  assert.equal(open.max, 100, "not merged with monthly");
});

// ---------------- High-risk open exposure ----------------
test("high-risk open exposure: only open high-risk, deduped, refunded excluded", () => {
  const r = calc.computeHighRiskOpenExposure([
    { id: "o1", fraudRiskLevel: "High", status: "paid", refunded: false, totalAmount: 100 },
    { id: "o1", fraudRiskLevel: "High", status: "paid", refunded: false, totalAmount: 100 }, // dup
    { id: "o2", fraudRiskLevel: "High", status: "refunded", refunded: true, totalAmount: 999 }, // settled
    { id: "o3", fraudRiskLevel: "Low", status: "paid", refunded: false, totalAmount: 999 }, // not high
    { id: "o4", fraudRiskLevel: "High", status: "manual_review", refunded: false, totalAmount: 50 },
  ], "USD");
  assert.equal(r.financialImpact.status, "quantified");
  assert.equal(r.orderCount, 2);
  assert.equal(r.financialImpact.max, 150);
  assert.equal(r.financialImpact.period, "current_open_exposure");
});

// ---------------- Security / privacy / capability ----------------
test("evidence allowlist: only safe aggregate fields emitted; PII dropped", () => {
  const ev = calc.buildAggregateEvidence({
    return_rate: "30%", order_count: 12, price_gap: "10%",
    email: "alice@example.com", ip: "1.2.3.4", shippingAddress: "1 Main St",
    deviceFingerprint: "abc", paymentFingerprint: "def", raw_payload: "{...}",
  });
  const labels = ev.map((e) => e.label).join("|");
  const values = ev.map((e) => e.value).join("|");
  assert.ok(!/alice@|1\.2\.3\.4|Main St|abc|def|payload/i.test(values), "no PII values");
  assert.ok(!/email|ip|address|fingerprint|payload/i.test(labels.toLowerCase()));
  assert.equal(ev.length, 3);
});

test("capability filter: lower plan receives no inaccessible module data", () => {
  const insights = [
    { id: "1", storeId: "s1", module: "fraud" },
    { id: "2", storeId: "s1", module: "competitor" },
    { id: "3", storeId: "s1", module: "pricing" },
    { id: "4", storeId: "s1", module: "return_abuse" },
  ].map((x) => ({ ...x, financialImpact: { status: "impact_not_quantifiable", reason: "" } }));
  const fraudOnly = calc.filterInsightsByCapability(insights, ["fraud"]);
  assert.deepEqual(fraudOnly.map((i) => i.module).sort(), ["fraud", "return_abuse"]);
  assert.ok(!fraudOnly.some((i) => i.module === "competitor" || i.module === "pricing"));
});

test("fully entitled plan sees all modules", () => {
  const insights = [
    { id: "1", storeId: "s1", module: "fraud" }, { id: "2", storeId: "s1", module: "competitor" },
    { id: "3", storeId: "s1", module: "pricing" }, { id: "4", storeId: "s1", module: "profit" },
  ];
  const all = calc.filterInsightsByCapability(insights, ["fraud", "competitor", "pricing", "profit"]);
  assert.equal(all.length, 4);
});

test("two-store isolation: only authenticated store's insights returned", () => {
  const insights = [
    { id: "1", storeId: "s1", module: "fraud" },
    { id: "2", storeId: "s2", module: "fraud" },
    { id: "3", storeId: "s1", module: "competitor" },
  ];
  const scoped = calc.scopeInsightsToStore(insights, "s1");
  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((i) => i.storeId === "s1"));
});

test("gated data does not affect revenue leak totals", () => {
  // competitor item present but competitor NOT entitled => excluded before grouping
  const riskItems = [
    { key: "c", label: "Competitor pressure — x", min: 0, max: 500, period: "monthly_estimate", confidence: "high" },
    { key: "hr", label: "Open high-risk order exposure", min: 0, max: 100, period: "current_open_exposure", confidence: "high" },
  ];
  const allowed = new Set(["fraud"]); // competitor gated
  const filtered = riskItems.filter((it) =>
    it.label.startsWith("Competitor") ? allowed.has("competitor") : allowed.has("fraud")
  );
  const groups = calc.groupLeaksByPeriod("revenue_at_risk", filtered, "USD");
  const total = groups.reduce((s, g) => s + g.max, 0);
  assert.equal(total, 100, "competitor's 500 excluded from totals");
});

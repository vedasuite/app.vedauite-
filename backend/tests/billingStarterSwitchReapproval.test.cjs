const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("active starter module change requires new Shopify billing approval", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const subscriptionServicePath = path.resolve(
    __dirname,
    "../dist/services/subscriptionService.js"
  );
  const shopifyAdminServicePath = path.resolve(
    __dirname,
    "../dist/services/shopifyAdminService.js"
  );
  const billingManagementServicePath = path.resolve(
    __dirname,
    "../dist/services/billingManagementService.js"
  );

  resetModule(prismaPath);
  resetModule(subscriptionServicePath);
  resetModule(shopifyAdminServicePath);
  resetModule(billingManagementServicePath);

  const prisma = require(prismaPath).prisma;
  const subscriptionService = require(subscriptionServicePath);
  const shopifyAdminService = require(shopifyAdminServicePath);

  const store = {
    id: "store-1",
    shop: "test-shop.myshopify.com",
    subscription: {
      id: "subscription-1",
      storeId: "store-1",
      starterModule: "fraud",
      active: true,
      billingStatus: "ACTIVE",
      shopifyChargeId: "gid://shopify/AppSubscription/100",
      plan: {
        id: "plan-starter",
        name: "STARTER",
        trialDays: 0,
      },
    },
    billingPlanIntents: [],
  };

  prisma.store.findUnique = async () => store;
  prisma.subscriptionPlan.findUnique = async () => ({
    id: "plan-starter",
    name: "STARTER",
    trialDays: 0,
  });
  prisma.billingPlanIntent.findFirst = async () => null;
  prisma.billingPlanIntent.create = async ({ data }) => ({
    id: "intent-1",
    ...data,
    createdAt: new Date("2026-05-05T12:00:00.000Z"),
    updatedAt: new Date("2026-05-05T12:00:00.000Z"),
    confirmedAt: null,
    cancelledAt: null,
  });
  prisma.billingPlanIntent.update = async ({ where, data }) => ({
    id: where.id,
    requestedPlanName: "STARTER",
    requestedStarterModule: "competitor",
    actionType: "update_starter_module",
    status: data.status ?? "PENDING_APPROVAL",
    confirmationUrl: data.confirmationUrl ?? "https://shopify.test/confirm",
    shopifyChargeId: data.shopifyChargeId ?? "gid://shopify/AppSubscription/200",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-05-05T12:00:00.000Z"),
    updatedAt: new Date("2026-05-05T12:01:00.000Z"),
    confirmedAt: null,
    cancelledAt: null,
    expiresAt: new Date("2026-05-05T13:00:00.000Z"),
  });
  prisma.billingPlanIntent.updateMany = async () => ({ count: 0 });
  prisma.billingAuditLog.create = async () => ({ id: "audit-1" });

  subscriptionService.getCurrentSubscription = async () => ({
    planName: "STARTER",
    active: true,
    starterModule: "fraud",
    billingStatus: "ACTIVE",
    capabilities: {
      "billing.planManagement": true,
      "billing.downgrade": true,
      "billing.moduleSelectionStarter": true,
    },
    enabledModules: {
      fraud: true,
      competitor: false,
      pricing: false,
      profit: false,
      trustAbuse: true,
      pricingProfit: false,
      reports: false,
      settings: true,
      creditScore: false,
      profitOptimization: false,
    },
  });
  subscriptionService.reconcileBillingState = async () => ({});
  subscriptionService.resolveBillingState = async () => ({
    lifecycle: "active",
    planName: "STARTER",
    planTier: "starter",
    normalizedBillingStatus: "ACTIVE",
    active: true,
    accessActive: true,
    verified: true,
    status: "active_paid",
    starterModule: "fraud",
    endsAt: null,
    renewalAt: null,
    showRenewalDate: false,
    showTrialDate: false,
    subscriptionId: "subscription-1",
    shopifyChargeId: "gid://shopify/AppSubscription/100",
    planSource: "database",
    dbPlanName: "STARTER",
    dbBillingStatus: "ACTIVE",
    lastBillingSyncAt: null,
    lastBillingWebhookProcessedAt: null,
    lastBillingResolutionSource: "database",
    pendingIntentStatus: "PENDING_APPROVAL",
    pendingRequestedPlanName: "STARTER",
    pendingRequestedStarterModule: "competitor",
    merchantTitle: "Starter plan is active",
    merchantDescription: "Starter billing is active.",
    mismatchWarnings: [],
  });

  shopifyAdminService.createAppSubscription = async () => ({
    confirmationUrl: "https://shopify.test/confirm",
    appSubscription: {
      id: "gid://shopify/AppSubscription/200",
    },
    userErrors: [],
  });

  const { requestBillingPlanChange } = require(billingManagementServicePath);

  const result = await requestBillingPlanChange({
    shopDomain: "test-shop.myshopify.com",
    requestedPlan: "STARTER",
    starterModule: "competitor",
    host: "embedded-host",
    returnPath: "/app/billing",
  });

  assert.equal(result.outcome, "REDIRECT_REQUIRED");
  assert.equal(result.pendingIntent.requestedPlanName, "STARTER");
  assert.equal(result.pendingIntent.requestedStarterModule, "competitor");
  assert.equal(result.pendingIntent.actionType, "update_starter_module");
});

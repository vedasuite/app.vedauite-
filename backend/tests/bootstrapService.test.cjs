const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function resetModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

test("bootstrap service no longer generates guided subscriptions or merchant data", async () => {
  const prismaPath = path.resolve(__dirname, "../dist/db/prismaClient.js");
  const envPath = path.resolve(__dirname, "../dist/config/env.js");
  const observabilityPath = path.resolve(
    __dirname,
    "../dist/services/observabilityService.js"
  );
  const bootstrapPath = path.resolve(
    __dirname,
    "../dist/services/bootstrapService.js"
  );

  resetModule(prismaPath);
  resetModule(envPath);
  resetModule(observabilityPath);
  resetModule(bootstrapPath);

  const storeRecord = {
    id: "store-1",
    shop: "test-shop.myshopify.com",
    installedAt: new Date("2026-05-02T00:00:00.000Z"),
  };

  const prismaModule = require(prismaPath);
  prismaModule.prisma.store.findUnique = async () => storeRecord;

  const envModule = require(envPath);
  envModule.env.enableGuidedBootstrap = true;

  const logEvents = [];
  require(observabilityPath).logEvent = (level, event, payload) => {
    logEvents.push({ level, event, payload });
  };

  const { ensureStoreBootstrapped } = require(bootstrapPath);
  await ensureStoreBootstrapped("test-shop.myshopify.com");

  assert.equal(logEvents.some((entry) => entry.event === "bootstrap.guided_bootstrap_ignored"), true);
  assert.equal(logEvents.some((entry) => entry.event === "bootstrap.checked"), true);
  assert.equal(
    logEvents.some((entry) =>
      JSON.stringify(entry.payload ?? {}).includes("generatedGuidedData")
    ),
    true
  );
});

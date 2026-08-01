const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://app.vedasuite.in";
process.env.DATABASE_URL ||= "postgresql://example:example@localhost:5432/example";

function mockModule(relPath, exports) {
  const abs = require.resolve(path.resolve(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// Capture what the service actually persists, without a database.
const created = [];
const fakePrisma = {
  store: {
    findUnique: async () => ({ id: "store-1", shop: "test-shop.myshopify.com" }),
  },
  supportTicket: {
    create: async ({ data }) => {
      created.push(data);
      return { ...data, id: `t${created.length}`, createdAt: new Date(), updatedAt: new Date() };
    },
    findMany: async () => [],
    count: async () => 0,
  },
};

mockModule("../dist/db/prismaClient.js", { prisma: fakePrisma });
mockModule("../dist/services/observabilityService.js", { logEvent: () => {} });

const supportPath = path.resolve(__dirname, "../dist/services/supportService.js");
const { SUPPORT_TICKET_CATEGORIES, createSupportTicket } = require(supportPath);

function lastStored() {
  return created[created.length - 1];
}

test("complaint and feedback are supported categories", () => {
  assert.ok(
    SUPPORT_TICKET_CATEGORIES.includes("complaint"),
    "complaint must be an accepted category"
  );
  assert.ok(
    SUPPORT_TICKET_CATEGORIES.includes("feedback"),
    "feedback must be an accepted category"
  );
});

test("the original categories are preserved", () => {
  for (const existing of ["general", "billing", "technical", "bug", "feature_request"]) {
    assert.ok(
      SUPPORT_TICKET_CATEGORIES.includes(existing),
      `${existing} must still be accepted`
    );
  }
});

test("a Complaint ticket is accepted and stored with that category", async () => {
  const result = await createSupportTicket("test-shop.myshopify.com", {
    subject: "Billing was charged twice",
    message: "I was charged two times this month and need a refund.",
    category: "complaint",
  });

  assert.equal(result.ok, true);
  assert.equal(lastStored().category, "complaint", "complaint must persist verbatim");
});

test("a Feedback ticket is accepted and stored with that category", async () => {
  const result = await createSupportTicket("test-shop.myshopify.com", {
    subject: "Love the new dashboard",
    message: "The executive summary makes the numbers much easier to follow.",
    category: "feedback",
  });

  assert.equal(result.ok, true);
  assert.equal(lastStored().category, "feedback", "feedback must persist verbatim");
});

test("an unrecognised category is rejected and coerced to general, never stored raw", async () => {
  const result = await createSupportTicket("test-shop.myshopify.com", {
    subject: "Testing an invalid category",
    message: "This should not persist the bogus category value.",
    category: "definitely_not_a_category",
  });

  assert.equal(result.ok, true, "the ticket itself should still be filed");
  assert.equal(
    lastStored().category,
    "general",
    "an invalid category must never reach the database"
  );
  assert.notEqual(lastStored().category, "definitely_not_a_category");
});

test("an omitted category falls back to general", async () => {
  await createSupportTicket("test-shop.myshopify.com", {
    subject: "No category supplied",
    message: "The service should default this safely.",
  });

  assert.equal(lastStored().category, "general");
});

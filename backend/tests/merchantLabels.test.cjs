const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const labelsPath = path.resolve(__dirname, "../dist/lib/merchantLabels.js");

test("formatMerchantOrderLabel never exposes internal or synthetic order ids", async () => {
  const { formatMerchantOrderLabel, getMerchantOrderLabelOrNull } = require(labelsPath);

  assert.equal(
    formatMerchantOrderLabel({
      orderName: "#1002",
      shopifyOrderId: "vedasuite-ai.myshopify.com-order-1002",
    }),
    "#1002"
  );
  assert.equal(
    formatMerchantOrderLabel({
      shopifyLegacyOrderId: "1002",
      shopifyOrderId: "vedasuite-ai.myshopify.com-order-1002",
    }),
    "#1002"
  );
  assert.equal(
    formatMerchantOrderLabel({
      shopifyOrderId: "vedasuite-ai.myshopify.com-order-1002",
      shopifyOrderGid: "gid://shopify/Order/1002",
    }),
    "Order pending sync"
  );
  assert.equal(
    getMerchantOrderLabelOrNull({
      shopifyOrderId: "vedasuite-ai.myshopify.com-order-1002",
      shopifyOrderGid: "gid://shopify/Order/1002",
    }),
    null
  );
});

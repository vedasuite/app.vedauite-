export type MerchantOrderLike = {
  orderName?: string | null;
  orderNumber?: string | number | null;
  shopifyLegacyOrderId?: string | number | null;
  shopifyOrderId?: string | null;
  shopifyOrderGid?: string | null;
};

const UNKNOWN_ORDER_LABEL = "Order pending sync";

function cleanOrderToken(value?: string | number | null) {
  if (value == null) {
    return null;
  }

  const token = String(value).trim();
  if (!token) {
    return null;
  }

  return token.replace(/^#/, "");
}

export function formatMerchantOrderLabel(order: MerchantOrderLike) {
  const label = getMerchantOrderLabelOrNull(order);
  return label ?? UNKNOWN_ORDER_LABEL;
}

export function getMerchantOrderLabelOrNull(order?: MerchantOrderLike | null) {
  if (!order) {
    return null;
  }

  if (order.orderName?.trim()) {
    return order.orderName.trim();
  }

  const orderToken =
    cleanOrderToken(order.orderNumber) ?? cleanOrderToken(order.shopifyLegacyOrderId);
  if (orderToken) {
    return `#${orderToken}`;
  }

  return null;
}

export function isInternalOrderLabel(value?: string | null) {
  if (!value) {
    return false;
  }

  return (
    value === UNKNOWN_ORDER_LABEL ||
    /\.myshopify\.com-order-\d+$/i.test(value) ||
    value.startsWith("gid://shopify/") ||
    /^order-[a-z0-9]+$/i.test(value)
  );
}

export function maskMerchantCustomerLabel(value?: string | null) {
  if (!value) {
    return "Customer profile";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "Customer profile";
  }

  if (!trimmed.includes("@")) {
    return "Customer profile";
  }

  const [name] = trimmed.split("@");
  const visible = name.slice(0, 2);
  return `${visible || "cu"}***`;
}

export function formatMerchantInsightTitle(input: {
  category: string;
  eventType: string;
  orderLabel?: string | null;
  severity?: string | null;
}) {
  if (input.category === "pricing" || input.category === "profit") {
    return "Pricing insight updated";
  }

  if (input.category === "competitor") {
    return "Competitor monitoring updated";
  }

  if (input.eventType === "refund_requested") {
    return input.orderLabel
      ? `Refund review needs attention on ${input.orderLabel}`
      : "Refund review needs attention";
  }

  if (input.category === "orders") {
    return input.orderLabel
      ? `Order review updated for ${input.orderLabel}`
      : "Order review updated";
  }

  if (input.category === "abuse") {
    return "Refund review needs attention";
  }

  if (input.category === "trust") {
    return "Customer profile updated";
  }

  if (input.severity === "critical") {
    return "Store review needs attention";
  }

  return "Store insight updated";
}

export function formatMerchantInsightDetail(input: {
  category: string;
  eventType: string;
  orderLabel?: string | null;
  detail: string;
}) {
  if (input.eventType === "refund_requested") {
    return input.orderLabel
      ? `${input.orderLabel} is waiting for refund review. Open Fraud Intelligence to review the supporting signals.`
      : "A recent order is waiting for refund review. Open Fraud Intelligence to review the supporting signals.";
  }

  if (input.category === "trust") {
    return "Customer trust signals were refreshed from the latest synced Shopify history.";
  }

  if (input.category === "abuse") {
    return "Refund and return behavior signals were refreshed from the latest synced Shopify history.";
  }

  return input.detail;
}

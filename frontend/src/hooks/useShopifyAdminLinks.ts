import { useAppBridge } from "../shopifyAppBridge";

function isNumericId(value?: string | null) {
  return !!value && /^\d+$/.test(value);
}

export function useShopifyAdminLinks() {
  const { shop } = useAppBridge();
  const storeHandle = shop.replace(".myshopify.com", "");

  const getOrderUrl = (shopifyOrderId?: string | null) => {
    if (!storeHandle || !isNumericId(shopifyOrderId)) {
      return null;
    }

    return `https://admin.shopify.com/store/${storeHandle}/orders/${shopifyOrderId}`;
  };

  const getCustomerUrl = (shopifyCustomerId?: string | null) => {
    if (!storeHandle || !isNumericId(shopifyCustomerId)) {
      return null;
    }

    return `https://admin.shopify.com/store/${storeHandle}/customers/${shopifyCustomerId}`;
  };

  const getProductUrl = (productHandle?: string | null) => {
    if (!storeHandle || !productHandle) {
      return null;
    }

    return `https://admin.shopify.com/store/${storeHandle}/products?query=${encodeURIComponent(
      productHandle
    )}`;
  };

  const getOrdersSearchUrl = (query?: string | null) => {
    if (!storeHandle || !query) {
      return null;
    }

    return `https://admin.shopify.com/store/${storeHandle}/orders?query=${encodeURIComponent(
      query
    )}`;
  };

  const getCustomersSearchUrl = (query?: string | null) => {
    if (!storeHandle || !query) {
      return null;
    }

    return `https://admin.shopify.com/store/${storeHandle}/customers?query=${encodeURIComponent(
      query
    )}`;
  };

  return {
    getOrderUrl,
    getCustomerUrl,
    getProductUrl,
    getOrdersSearchUrl,
    getCustomersSearchUrl,
  };
}

const HOST_STORAGE_KEY = "vedasuite:embedded:host";
const SHOP_STORAGE_KEY = "vedasuite:embedded:shop";

type EmbeddedContext = {
  host: string;
  shop: string;
};

function canUseSessionStorage() {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

function readStoredValue(key: string) {
  if (!canUseSessionStorage()) {
    return "";
  }

  return window.sessionStorage.getItem(key) ?? "";
}

function writeStoredValue(key: string, value: string) {
  if (!canUseSessionStorage() || !value) {
    return;
  }

  window.sessionStorage.setItem(key, value);
}

function parseShopFromReferrer() {
  if (typeof document === "undefined" || !document.referrer) {
    return "";
  }

  try {
    const referrer = new URL(document.referrer);
    const match = referrer.pathname.match(/\/store\/([^/]+)/i);
    if (!match?.[1]) {
      return "";
    }

    return `${match[1]}.myshopify.com`;
  } catch {
    return "";
  }
}

export function getEmbeddedContext(): EmbeddedContext {
  if (typeof window === "undefined") {
    return { host: "", shop: "" };
  }

  const params = new URLSearchParams(window.location.search);
  const urlHost = params.get("host") ?? "";
  const urlShop = params.get("shop") ?? "";

  const host = urlHost || readStoredValue(HOST_STORAGE_KEY);
  const shop = urlShop || readStoredValue(SHOP_STORAGE_KEY) || parseShopFromReferrer();

  if (urlHost) {
    writeStoredValue(HOST_STORAGE_KEY, urlHost);
  }
  if (urlShop) {
    writeStoredValue(SHOP_STORAGE_KEY, urlShop);
  } else if (shop) {
    writeStoredValue(SHOP_STORAGE_KEY, shop);
  }

  return { host, shop };
}

export function hasEmbeddedContext() {
  const { host, shop } = getEmbeddedContext();
  return !!host && !!shop;
}

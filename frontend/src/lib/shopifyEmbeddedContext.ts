const HOST_STORAGE_KEY = "vedasuite:embedded:host";
const SHOP_STORAGE_KEY = "vedasuite:embedded:shop";

type EmbeddedContext = {
  host: string;
  shop: string;
};

function canUseSessionStorage() {
  return typeof window !== "undefined" && !!window.sessionStorage;
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function normalizeShop(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(normalized)) {
    return "";
  }

  return normalized;
}

function normalizeHost(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return btoa(atob(trimmed)) === trimmed ? trimmed : "";
  } catch {
    return "";
  }
}

function readStoredValue(key: string) {
  if (!canUseSessionStorage() && !canUseLocalStorage()) {
    return "";
  }

  return (
    (canUseSessionStorage() ? window.sessionStorage.getItem(key) : null) ??
    (canUseLocalStorage() ? window.localStorage.getItem(key) : null) ??
    ""
  );
}

function writeStoredValue(key: string, value: string) {
  if (!value) {
    return;
  }

  if (canUseSessionStorage()) {
    window.sessionStorage.setItem(key, value);
  }
  if (canUseLocalStorage()) {
    window.localStorage.setItem(key, value);
  }
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
  const urlHost = normalizeHost(params.get("host") ?? "");
  const urlShop = normalizeShop(params.get("shop") ?? "");

  const storedHost = normalizeHost(readStoredValue(HOST_STORAGE_KEY));
  const storedShop = normalizeShop(readStoredValue(SHOP_STORAGE_KEY));
  const referrerShop = normalizeShop(parseShopFromReferrer());

  const host = urlHost || storedHost;
  const shop = urlShop || storedShop || referrerShop;

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

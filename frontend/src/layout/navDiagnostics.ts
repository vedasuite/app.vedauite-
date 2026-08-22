/**
 * TEMPORARY diagnostic for the reported Action Center disappearance after
 * billing confirmation / onboarding completion.
 *
 * The first diagnostic logged what AppFrame BUILT. That was not enough: the
 * navigation model is provably total (see backend/tests/navigationRuntime.test.cjs),
 * so if an entry is missing on screen while the built array still contains it,
 * the loss happens after our code hands the list to Polaris. This version
 * therefore reports both sides:
 *
 *   built*  — what AppFrame passed to <Navigation.Section items={...}>
 *   dom*    — what is actually rendered in the document right now
 *
 * A built/dom disagreement localises the bug precisely.
 *
 * It also captures the App Bridge identity, because index.html hardcodes a
 * shopify-api-key and the staging deployment has no build-time override.
 *
 * Contains no customer, order or token data. Every read is wrapped so a
 * diagnostic failure can never affect rendering. Remove once the cause is
 * confirmed.
 */

export type NavDiagnosticSnapshot = Record<string, unknown>;

const HISTORY_LIMIT = 40;

type DiagnosticWindow = Window & {
  __vsNav?: {
    history: NavDiagnosticSnapshot[];
    dump: () => string;
    last: () => NavDiagnosticSnapshot | null;
  };
  shopify?: { config?: { apiKey?: string; shop?: string; host?: string } };
};

function diagWindow(): DiagnosticWindow | null {
  return typeof window === "undefined" ? null : (window as DiagnosticWindow);
}

/**
 * Labels currently rendered inside the Polaris navigation, read from the DOM.
 * Returns null when the navigation is not in the document at all — which is
 * itself the answer if the whole nav has gone, rather than one entry.
 */
function readDomNavLabels(): string[] | null {
  try {
    const nav = document.querySelector(".Polaris-Navigation");
    if (!nav) {
      return null;
    }
    const nodes = nav.querySelectorAll(
      ".Polaris-Navigation__Text, .Polaris-Navigation__Item span"
    );
    const labels: string[] = [];
    nodes.forEach((node) => {
      const text = (node.textContent ?? "").trim();
      // Badges render inside the item too; keep only the first text per item.
      if (text && !labels.includes(text) && text !== "Upgrade") {
        labels.push(text);
      }
    });
    return labels;
  } catch {
    return null;
  }
}

function readAppBridgeIdentity() {
  const win = diagWindow();
  try {
    const meta = document
      .querySelector('meta[name="shopify-api-key"]')
      ?.getAttribute("content");
    return {
      // Present only if App Bridge actually initialised.
      appBridgePresent: !!win?.shopify,
      // What App Bridge believes the app is — the audience of every session token.
      appBridgeApiKey: win?.shopify?.config?.apiKey ?? null,
      // What index.html declares. A mismatch between these two, or between
      // either and the backend's SHOPIFY_API_KEY, breaks session-token auth.
      metaApiKey: meta ?? null,
      appBridgeHostPresent: !!win?.shopify?.config?.host,
    };
  } catch {
    return { appBridgePresent: false, appBridgeApiKey: null, metaApiKey: null };
  }
}

/**
 * Records one snapshot: logs it and appends it to window.__vsNav.history so the
 * whole before/after sequence can be dumped in one paste after the fact,
 * instead of being scrolled for in the console.
 */
export function recordNavDiagnostic(built: NavDiagnosticSnapshot) {
  const win = diagWindow();
  if (!win) {
    return;
  }

  try {
    const domLabels = readDomNavLabels();
    const builtLabels = Array.isArray(built.builtNavLabels)
      ? (built.builtNavLabels as string[])
      : [];

    const snapshot: NavDiagnosticSnapshot = {
      ...built,
      ...readAppBridgeIdentity(),
      // App Bridge mirrors the iframe's document.title into the Shopify Admin
      // header, so this is what the merchant sees as the app name.
      documentTitle: typeof document !== "undefined" ? document.title : null,
      navPresentInDom: domLabels !== null,
      domNavLabels: domLabels,
      domNavCount: domLabels?.length ?? 0,
      domHasActionCenter: domLabels?.includes("Action Center") ?? false,
      // THE decisive field: true means our array and the screen disagree.
      builtDomMismatch:
        domLabels !== null && builtLabels.length !== domLabels.length,
    };

    if (!win.__vsNav) {
      const history: NavDiagnosticSnapshot[] = [];
      win.__vsNav = {
        history,
        dump: () => JSON.stringify(history, null, 2),
        last: () => history[history.length - 1] ?? null,
      };
    }

    win.__vsNav.history.push(snapshot);
    if (win.__vsNav.history.length > HISTORY_LIMIT) {
      win.__vsNav.history.shift();
    }

    // eslint-disable-next-line no-console
    console.info("[vedasuite:nav-diagnostic]", snapshot);
  } catch {
    /* diagnostics must never affect rendering */
  }
}

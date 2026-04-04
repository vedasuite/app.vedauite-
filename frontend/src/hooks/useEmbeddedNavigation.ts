import { useLocation, useNavigate } from "react-router-dom";
import { getEmbeddedContext } from "../lib/shopifyEmbeddedContext";

export function useEmbeddedNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  const buildEmbeddedPath = (targetPath: string) => {
    const [pathname, search = ""] = targetPath.split("?");
    const currentParams = new URLSearchParams(location.search);
    const embeddedContext = getEmbeddedContext();
    const nextParams = new URLSearchParams(search);

    currentParams.forEach((value, key) => {
      if (!nextParams.has(key)) {
        nextParams.set(key, value);
      }
    });
    if (!nextParams.has("host") && embeddedContext.host) {
      nextParams.set("host", embeddedContext.host);
    }
    if (!nextParams.has("shop") && embeddedContext.shop) {
      nextParams.set("shop", embeddedContext.shop);
    }

    const nextSearch = nextParams.toString();
    return nextSearch ? `${pathname}?${nextSearch}` : pathname;
  };

  const navigateEmbedded = (targetPath: string) => {
    navigate(buildEmbeddedPath(targetPath));
  };

  return {
    buildEmbeddedPath,
    navigateEmbedded,
  };
}

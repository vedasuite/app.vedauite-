import { useLocation, useNavigate } from "react-router-dom";

export function useEmbeddedNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  const buildEmbeddedPath = (targetPath: string) => {
    const [pathname, search = ""] = targetPath.split("?");
    const currentParams = new URLSearchParams(location.search);
    const nextParams = new URLSearchParams(search);

    currentParams.forEach((value, key) => {
      if (!nextParams.has(key)) {
        nextParams.set(key, value);
      }
    });

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

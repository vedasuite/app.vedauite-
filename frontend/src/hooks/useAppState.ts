import { useContext } from "react";
import { AppStateContext } from "../providers/AppStateProvider";

export function useAppState() {
  const context = useContext(AppStateContext);

  if (!context) {
    return {
      appState: null,
      status: "loading" as const,
      error: null,
      bootstrap: {
        status: "initializing_embedded_context" as const,
        shop: null,
        host: null,
        errorCode: null,
        errorMessage: null,
        reconnectUrl: null,
      },
      refresh: async () => {
        throw new Error("App state context is not available.");
      },
    };
  }

  return context;
}

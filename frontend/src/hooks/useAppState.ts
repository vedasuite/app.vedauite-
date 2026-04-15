import { useContext } from "react";
import { AppStateContext } from "../providers/AppStateProvider";

export function useAppState() {
  const context = useContext(AppStateContext);

  if (!context) {
    return {
      appState: null,
      status: "loading" as const,
      error: null,
      refresh: async () => {
        throw new Error("App state context is not available.");
      },
    };
  }

  return context;
}

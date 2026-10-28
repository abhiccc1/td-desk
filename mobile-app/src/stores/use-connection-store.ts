import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizeApiUrl, normalizeWsUrl } from "@/lib/url";

const STORAGE_KEY = "td-desk-mobile:connection";

type ConnectionConfig = {
  apiUrl: string;
  wsUrl: string;
  /** Legacy identity — only used when the backend has no KOTAK_ACCOUNTS profiles. */
  kotakMobile: string;
  kotakUcc: string;
  /** Last account profile signed into, pre-selected on the login screen. */
  lastAccountId: string;
};

type ConnectionState = {
  config: ConnectionConfig;
  setConfig: (config: ConnectionConfig) => Promise<void>;
};

const defaults: ConnectionConfig = {
  apiUrl: "http://localhost:8000",
  wsUrl: "ws://localhost:8000/ws/stream",
  kotakMobile: "",
  kotakUcc: "",
  lastAccountId: "",
};

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set) => ({
      config: defaults,
      setConfig: async (config) => {
        set({
          config: {
            apiUrl: normalizeApiUrl(config.apiUrl || defaults.apiUrl),
            wsUrl: normalizeWsUrl(config.wsUrl || defaults.wsUrl),
            kotakMobile: (config.kotakMobile || "").trim(),
            kotakUcc: (config.kotakUcc || "").trim().toUpperCase(),
            lastAccountId: (config.lastAccountId || "").trim(),
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      merge: (persistedState, currentState) => {
        const typedState = persistedState as Partial<ConnectionState> | undefined;
        const persistedConfig = typedState?.config;

        return {
          ...currentState,
          ...typedState,
          config: {
            ...defaults,
            ...currentState.config,
            ...persistedConfig,
            apiUrl: normalizeApiUrl(persistedConfig?.apiUrl || currentState.config.apiUrl),
            wsUrl: normalizeWsUrl(persistedConfig?.wsUrl || currentState.config.wsUrl),
            kotakMobile: (persistedConfig?.kotakMobile || currentState.config.kotakMobile || "").trim(),
            kotakUcc: (persistedConfig?.kotakUcc || currentState.config.kotakUcc || "").trim().toUpperCase(),
            lastAccountId: (persistedConfig?.lastAccountId || currentState.config.lastAccountId || "").trim(),
          },
        };
      },
    },
  ),
);

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { authSessionKey, fetchKotakSession } from "@/lib/api";
import { useConnectionStore } from "@/stores/use-connection-store";

export type MobileAuthState = "authenticated" | "totp_pending" | "unauthenticated" | "unknown";

export function useAuthStatus() {
  const apiUrl = useConnectionStore((state) => state.config.apiUrl);

  const query = useQuery({
    queryKey: authSessionKey(apiUrl),
    queryFn: fetchKotakSession,
    retry: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });

  const sessionState = useMemo<MobileAuthState>(() => {
    if (query.isError) return "unknown";
    if (!query.data) return "unknown";

    if (query.data.state === "active" || query.data.state === "degraded") {
      return "authenticated";
    }
    if (query.data.state === "totp_pending") {
      return "totp_pending";
    }
    return "unauthenticated";
  }, [query.data, query.isError]);

  return {
    ...query,
    sessionState,
    isAuthenticated: sessionState === "authenticated",
    apiReachable: !query.isError,
    /** Broker account profile currently signed in, when the session is live. */
    accountId: sessionState === "authenticated" ? query.data?.accountId ?? "" : "",
    ucc: sessionState === "authenticated" ? query.data?.ucc ?? "" : "",
  };
}

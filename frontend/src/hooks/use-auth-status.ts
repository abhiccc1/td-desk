import { useState, useEffect, useCallback } from "react";
import { getConfig } from "@/lib/config";

interface AuthStatus {
  broker: string;
  state: string;
  client_id: string;
  /** Broker account profile currently signed in. */
  accountId?: string;
  ucc?: string;
}

interface SessionStatusResponse {
  state: string;
  version: number;
  lastHealthCheck: string | null;
  healthCheckOk: boolean;
  authenticatedAt: string | null;
  accountId?: string;
  ucc?: string;
}

export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const { apiUrl } = getConfig();
      const sessionResp = await fetch(`${apiUrl}/api/v1/auth/kotak/session`);
      if (sessionResp.ok) {
        const session = await sessionResp.json() as SessionStatusResponse;
        if (session.state === "active" || session.state === "degraded") {
          setStatus({
            broker: "kotak",
            state: "authenticated",
            client_id: session.ucc ?? "",
            accountId: session.accountId ?? "",
            ucc: session.ucc ?? "",
          });
          return;
        }
        if (session.state === "totp_pending") {
          setStatus({
            broker: "kotak",
            state: "totp_pending",
            client_id: "",
          });
          return;
        }
        if (session.state === "expired") {
          setStatus({
            broker: "kotak",
            state: "unauthenticated",
            client_id: "",
          });
          return;
        }
      }

      const resp = await fetch(`${apiUrl}/api/v1/auth/kotak/status`);
      if (!resp.ok) {
        setStatus(null);
        return;
      }
      const data = await resp.json();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  /** End the broker session so a different account can be signed into. */
  const logout = useCallback(async () => {
    const { apiUrl } = getConfig();
    try {
      await fetch(`${apiUrl}/api/v1/auth/kotak/logout`, { method: "POST" });
    } catch {
      // Fall through to refetch — the UI should reflect reality either way.
    }
    await refetch();
  }, [refetch]);

  const isAuthenticated = status !== null && status.state === "authenticated";

  return { status, loading, isAuthenticated, refetch, logout };
}

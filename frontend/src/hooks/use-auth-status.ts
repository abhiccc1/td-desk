import { useState, useEffect, useCallback } from "react";
import { getConfig } from "@/lib/config";

interface AuthStatus {
  broker: string;
  state: string;
  client_id: string;
}

export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const { apiUrl } = getConfig();
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

  const isAuthenticated = status !== null && status.state === "authenticated";

  return { status, loading, isAuthenticated, refetch };
}

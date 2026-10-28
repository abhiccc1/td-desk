"use client";

import { useCallback, useEffect, useState } from "react";

import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getConfig, rememberAccount } from "@/lib/config";

interface Props {
  onAuthenticated: () => void;
  apiReachable?: boolean;
  onOpenSettings?: () => void;
}

interface AccountOption {
  id: string;
  label: string;
  ucc: string;
  mobileMasked: string;
}

interface AccountsResponse {
  accounts: AccountOption[];
  activeAccountId: string;
  /** True when the backend has no server-side profiles and expects mobile/UCC from us. */
  clientSuppliedIdentity: boolean;
}

export function KotakLogin({ onAuthenticated, apiReachable = true, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<"totp" | "mpin">("totp");
  const [totp, setTotp] = useState("");
  const [mpin, setMpin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [legacyMode, setLegacyMode] = useState(false);
  const [brokerConfigured, setBrokerConfigured] = useState(true);

  const config = getConfig();

  // Server-side account profiles keep the consumer key off the client; only when
  // none are configured does the backend fall back to our stored mobile/UCC.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${getConfig().apiUrl}/api/v1/auth/kotak/accounts`);
        if (!resp.ok) throw new Error("accounts unavailable");
        const data = (await resp.json()) as AccountsResponse;
        if (cancelled) return;
        const list = data.accounts ?? [];
        setAccounts(list);
        // No profiles but a legacy consumer key present → the backend still
        // wants mobile/UCC from our settings. Neither → nothing is configured.
        setLegacyMode(list.length === 0 && data.clientSuppliedIdentity);
        setBrokerConfigured(list.length > 0 || data.clientSuppliedIdentity);
        const preferred =
          data.activeAccountId ||
          (data.accounts ?? []).find((a) => a.id === config.lastAccountId)?.id ||
          data.accounts?.[0]?.id ||
          "";
        setAccountId(preferred);
      } catch {
        // Backend unreachable or an older build without /accounts — fall back to
        // the client-supplied identity path rather than blocking login.
        if (!cancelled) {
          setLegacyMode(true);
          setBrokerConfigured(true);
        }
      } finally {
        if (!cancelled) setAccountsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.lastAccountId]);

  const missingConfig: string[] = [];
  if (legacyMode && !config.kotakMobile) missingConfig.push("Mobile Number");
  if (legacyMode && !config.kotakUcc) missingConfig.push("UCC");
  const configMissing = missingConfig.length > 0;
  const noAccounts = accountsLoaded && !brokerConfigured;
  const blocked = configMissing || noAccounts || !accountsLoaded;

  const handleLogin = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);
      setLoading(true);
      try {
        const { apiUrl, kotakMobile, kotakUcc } = getConfig();
        const body: Record<string, string> = { totp };
        if (accountId) body.account_id = accountId;
        if (legacyMode) {
          body.mobile = kotakMobile;
          body.ucc = kotakUcc;
        }

        const loginResp = await fetch(`${apiUrl}/api/v1/auth/kotak/totp-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!loginResp.ok) {
          const data = await loginResp.json().catch(() => ({ detail: "Login failed" }));
          throw new Error(data.detail || "Login failed");
        }
        const data = await loginResp.json().catch(() => ({}));
        if (data.accountId) setAccountId(data.accountId);
        setPhase("mpin");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Login failed");
        setTotp("");
      } finally {
        setLoading(false);
      }
    },
    [totp, accountId, legacyMode],
  );

  const handleVerify = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setError(null);
      setLoading(true);
      try {
        const { apiUrl } = getConfig();
        const resp = await fetch(`${apiUrl}/api/v1/auth/kotak/totp-validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(accountId ? { mpin, account_id: accountId } : { mpin }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({ detail: "Verification failed" }));
          throw new Error(data.detail || "Verification failed");
        }
        if (accountId) rememberAccount(accountId);
        onAuthenticated();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Verification failed");
        setMpin("");
      } finally {
        setLoading(false);
      }
    },
    [mpin, accountId, onAuthenticated],
  );

  useEffect(() => {
    if (totp.length === 6 && !loading && !blocked) handleLogin();
  }, [totp, loading, blocked, handleLogin]);

  useEffect(() => {
    if (mpin.length === 6 && !loading) handleVerify();
  }, [mpin, loading, handleVerify]);

  const selected = accounts.find((a) => a.id === accountId);

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-xl font-bold text-card-foreground">Kotak Neo</h1>
          {onOpenSettings && (
            <Button
              onClick={onOpenSettings}
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              title="Settings"
            >
              <Settings size={16} />
            </Button>
          )}
        </div>
        <p className="mb-6 text-sm text-muted-foreground">
          {phase === "totp" ? "Enter TOTP to sign in" : "Enter your MPIN"}
        </p>

        {!apiReachable && (
          <div className="mb-4 rounded-sm border border-yellow-600/40 bg-yellow-600/10 px-3 py-3 text-sm text-yellow-500">
            <p className="font-medium">Backend unreachable</p>
            <p className="mt-1 text-xs text-yellow-500/80">
              Check your API URL in Settings and make sure the backend is running.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onAuthenticated}
            >
              Retry connection
            </Button>
          </div>
        )}

        {noAccounts && (
          <div className="mb-4 rounded-sm border border-red-600/40 bg-red-600/10 px-3 py-3 text-sm text-red-400">
            <p className="font-medium">No broker accounts configured</p>
            <p className="mt-1 text-xs text-red-400/80">
              Set <code>KOTAK_ACCOUNTS</code> (or <code>KOTAK_CONSUMER_KEY</code>) in the
              backend .env and restart it.
            </p>
          </div>
        )}

        {configMissing && (
          <div className="mb-4 rounded-sm border border-red-600/40 bg-red-600/10 px-3 py-3 text-sm text-red-400">
            <p className="font-medium">Missing configuration</p>
            <p className="mt-1 text-xs text-red-400/80">
              Open Settings (gear icon) and set:
            </p>
            <ul className="mt-1 list-inside list-disc text-xs text-red-300">
              {missingConfig.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-sm bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {accounts.length > 0 && (
          <label className="mb-4 flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Account</span>
            <Select
              value={accountId}
              disabled={phase === "mpin" || loading}
              onChange={(e) => {
                setAccountId(e.target.value);
                setError(null);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.ucc ? ` — ${a.ucc}` : ""}
                </option>
              ))}
            </Select>
            {selected?.mobileMasked && (
              <span className="text-xs text-muted-foreground">{selected.mobileMasked}</span>
            )}
          </label>
        )}

        {phase === "totp" ? (
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">TOTP (from authenticator app)</span>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                required
                autoFocus
                className="text-center text-lg tracking-widest"
                placeholder="------"
              />
            </label>
            <Button
              type="submit"
              disabled={loading || totp.length < 6 || blocked}
              className="mt-2"
              size="lg"
            >
              {loading ? "Logging in..." : "Login with TOTP"}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Enter your MPIN</span>
              <Input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={mpin}
                onChange={(e) => setMpin(e.target.value.replace(/\D/g, ""))}
                required
                autoFocus
                className="text-center text-lg tracking-widest"
                placeholder="------"
              />
            </label>
            <Button
              type="submit"
              disabled={loading || mpin.length < 6}
              className="mt-2"
              size="lg"
            >
              {loading ? "Verifying..." : "Verify MPIN"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

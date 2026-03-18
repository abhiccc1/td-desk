"use client";

import { useState } from "react";

import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getConfig } from "@/lib/config";

interface Props {
  onAuthenticated: () => void;
  apiReachable?: boolean;
  onOpenSettings?: () => void;
}

export function KotakLogin({ onAuthenticated, apiReachable = true, onOpenSettings }: Props) {
  const [phase, setPhase] = useState<"totp" | "mpin">("totp");
  const [totp, setTotp] = useState("");
  const [mpin, setMpin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const config = getConfig();
  const missingConfig: string[] = [];
  if (!config.kotakMobile) missingConfig.push("Mobile Number");
  if (!config.kotakUcc) missingConfig.push("UCC");
  const configMissing = missingConfig.length > 0;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { apiUrl, kotakMobile, kotakUcc } = getConfig();

      // Step 1: TOTP login (Kotak Neo API v2 — no session_init needed)
      const loginResp = await fetch(`${apiUrl}/api/v1/auth/kotak/totp-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile: kotakMobile, ucc: kotakUcc, totp }),
      });
      if (!loginResp.ok) {
        const data = await loginResp.json().catch(() => ({ detail: "Login failed" }));
        throw new Error(data.detail || "Login failed");
      }
      setPhase("mpin");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { apiUrl } = getConfig();
      const resp = await fetch(`${apiUrl}/api/v1/auth/kotak/totp-validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mpin }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Verification failed" }));
        throw new Error(data.detail || "Verification failed");
      }
      onAuthenticated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

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
              disabled={loading || totp.length < 6 || configMissing}
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

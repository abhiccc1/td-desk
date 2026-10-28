"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getConfig, saveConfig, resetConfig, type AppConfig } from "@/lib/config";

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const current = getConfig();
  const [form, setForm] = useState<AppConfig>({ ...current });
  const [saved, setSaved] = useState(false);

  const set = (key: keyof AppConfig, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = () => {
    saveConfig(form);
    setSaved(true);
  };

  const handleReset = () => {
    resetConfig();
    const defaults = getConfig();
    setForm({ ...defaults });
    setSaved(false);
  };

  return (
    <div className="flex h-screen flex-col bg-panel">
      <div className="flex items-center gap-3 border-b border-panel-border bg-panel-header px-4 py-2">
        <Button
          onClick={onClose}
          variant="ghost"
          size="sm"
          className="gap-1 px-2 text-panel-faint hover:text-panel-muted"
        >
          <ArrowLeft size={14} />
          Back
        </Button>
        <h1 className="text-sm font-medium text-panel-muted">Settings</h1>
      </div>

      <div className="mx-auto w-full max-w-lg flex-1 overflow-y-auto p-6">
        <section className="mb-8">
          <h2 className="mb-1 text-sm font-semibold text-card-foreground">Connection</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Backend API and WebSocket URLs. Changes take effect on next app restart.
          </p>

          <label className="mb-3 flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">API URL</span>
            <Input
              type="url"
              value={form.apiUrl}
              onChange={(e) => set("apiUrl", e.target.value)}
              placeholder="http://localhost:8000"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">WebSocket URL</span>
            <Input
              type="url"
              value={form.wsUrl}
              onChange={(e) => set("wsUrl", e.target.value)}
              placeholder="ws://localhost:8000/ws/stream"
            />
          </label>
        </section>

        <section className="mb-8">
          <h2 className="mb-1 text-sm font-semibold text-card-foreground">Kotak Neo</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Fallback identity for TOTP login. Ignored when the backend has account
            profiles configured — those supply the mobile number and UCC, and the
            login screen shows a picker instead.
          </p>

          <div className="mb-4 rounded-sm border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            To trade multiple accounts, set <code>KOTAK_ACCOUNTS</code> in the backend
            <code> .env</code> — a JSON array of{" "}
            <code>{`{id, label, consumer_key, mobile, ucc}`}</code>. Consumer keys stay
            on the server and are never sent to this app.
          </div>

          <label className="mb-3 flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Mobile Number</span>
            <Input
              type="tel"
              value={form.kotakMobile}
              onChange={(e) => set("kotakMobile", e.target.value)}
              placeholder="+91XXXXXXXXXX"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">UCC (Unique Client Code)</span>
            <Input
              type="text"
              value={form.kotakUcc}
              onChange={(e) => set("kotakUcc", e.target.value)}
              placeholder="Your client code"
            />
          </label>
        </section>

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} size="lg">
            {saved ? "Saved - restart app to apply" : "Save"}
          </Button>
          <Button onClick={handleReset} variant="outline" size="lg">
            Reset to defaults
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { KotakLogin } from "@/components/auth/kotak-login";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { useAuthStatus } from "@/hooks/use-auth-status";
import { DataFeedOrchestrator } from "@/lib/data-feed-orchestrator";
import { useMarketDataStore } from "@/stores/market-data-store";

const TradingDashboard = dynamic(
  () => import("@/components/dashboard/trading-dashboard"),
  { ssr: false },
);

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === "true";

export default function Home() {
  const { status, loading, isAuthenticated, refetch } = useAuthStatus();
  const setBrokerStatus = useMarketDataStore((s) => s.setBrokerStatus);
  const [showSettings, setShowSettings] = useState(false);

  // Sync broker status to store
  useEffect(() => {
    if (IS_MOCK) return;
    if (loading) {
      setBrokerStatus("authenticating");
    } else if (isAuthenticated) {
      setBrokerStatus("connected");
    } else {
      setBrokerStatus("disconnected");
    }
  }, [loading, isAuthenticated, setBrokerStatus]);

  useEffect(() => {
    if (IS_MOCK || (!loading && isAuthenticated)) {
      const orchestrator = new DataFeedOrchestrator();
      orchestrator.init();
      return () => orchestrator.destroy();
    }
  }, [loading, isAuthenticated]);

  // Settings page (accessible from any state)
  if (showSettings) {
    return <SettingsPanel onClose={() => setShowSettings(false)} />;
  }

  // In mock mode, skip auth entirely
  if (IS_MOCK) {
    return (
      <main className="h-screen w-screen overflow-hidden">
        <TradingDashboard onOpenSettings={() => setShowSettings(true)} />
      </main>
    );
  }

  // Non-mock: wait for auth status check
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Checking authentication...
      </div>
    );
  }

  // Non-mock: show login if not authenticated
  if (!isAuthenticated) {
    return <KotakLogin onAuthenticated={refetch} apiReachable={status !== null} onOpenSettings={() => setShowSettings(true)} />;
  }

  return (
    <main className="h-screen w-screen overflow-hidden">
      <TradingDashboard onOpenSettings={() => setShowSettings(true)} />
    </main>
  );
}

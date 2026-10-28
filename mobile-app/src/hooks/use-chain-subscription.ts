import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import { optionChainKey } from "@/lib/api";
import {
  clearDemandContribution,
  FOREGROUND_THROTTLE_MS,
  REASSERT_INTERVAL_MS,
  setDemandContribution,
  throttleFor,
} from "@/lib/ws/demand";
import { streamClient } from "@/lib/ws/stream-client";
import type { OptionChainSnapshot } from "@/types/api";

export function useChainSubscription(underlying: string, expiry: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!underlying || !expiry) return;

    const topic = `ticks:chain:${underlying}:${expiry}`;
    streamClient.connect();
    streamClient.subscribe([topic]);

    const pushDemand = () => {
      setDemandContribution("chain", [
        { underlying, expiry, throttleMs: throttleFor(FOREGROUND_THROTTLE_MS) },
      ]);
    };
    pushDemand();

    const appStateSub = AppState.addEventListener("change", pushDemand);
    const reassert = setInterval(pushDemand, REASSERT_INTERVAL_MS);

    const unsubscribe = streamClient.onMessage((incomingTopic, payload) => {
      if (incomingTopic !== topic) return;
      queryClient.setQueryData(optionChainKey(underlying, expiry), payload as OptionChainSnapshot);
    });

    return () => {
      clearInterval(reassert);
      appStateSub.remove();
      unsubscribe();
      // Drop the claim before unsubscribing so the chain is released rather
      // than left pinned at this screen's last asserted rate.
      clearDemandContribution("chain");
      streamClient.unsubscribe([topic]);
    };
  }, [expiry, queryClient, underlying]);
}

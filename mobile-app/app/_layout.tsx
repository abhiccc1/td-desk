import "react-native-gesture-handler";

import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useHydrateConnectionStore } from "@/hooks/use-hydrate-connection-store";
import { useHydrateSegmentStore } from "@/hooks/use-hydrate-segment-store";
import { palette } from "@/lib/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnReconnect: true,
    },
  },
});

export default function RootLayout() {
  const connectionHydrated = useHydrateConnectionStore();
  const segmentHydrated = useHydrateSegmentStore();

  if (!connectionHydrated || !segmentHydrated) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: palette.bg }}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false }} />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  );
}

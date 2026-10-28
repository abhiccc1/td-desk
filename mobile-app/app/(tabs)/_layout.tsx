import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs, type Href } from "expo-router";

import { useAuthStatus } from "@/hooks/use-auth-status";
import { palette } from "@/lib/theme";

export default function TabsLayout() {
  const { sessionState, isPending } = useAuthStatus();

  if (isPending) return null;
  if (sessionState === "unauthenticated" || sessionState === "totp_pending") {
    return <Redirect href={"/login" as Href} />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        headerStyle: {
          backgroundColor: palette.panel,
        },
        headerTintColor: palette.text,
        tabBarStyle: {
          backgroundColor: palette.panel,
          borderTopColor: palette.border,
        },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.muted,
        sceneStyle: {
          backgroundColor: palette.bg,
        },
      }}
    >
      <Tabs.Screen
        name="chain"
        options={{
          title: "Chain",
          tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: "Basket",
          tabBarIcon: ({ color, size }) => <Ionicons name="basket" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="order-book"
        options={{
          title: "Orders",
          tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="positions"
        options={{
          title: "Positions",
          tabBarIcon: ({ color, size }) => <Ionicons name="briefcase" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Ionicons name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

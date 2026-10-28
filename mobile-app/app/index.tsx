import { Redirect, type Href } from "expo-router";

import { useAuthStatus } from "@/hooks/use-auth-status";

export default function IndexScreen() {
  const { sessionState, isPending } = useAuthStatus();

  if (isPending) return null;
  if (sessionState === "authenticated") {
    return <Redirect href="/(tabs)/chain" />;
  }

  return <Redirect href={"/login" as Href} />;
}

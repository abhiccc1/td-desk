import { useEffect, useState } from "react";

import { useConnectionStore } from "@/stores/use-connection-store";

export function useHydrateConnectionStore() {
  const [hydrated, setHydrated] = useState(useConnectionStore.persist.hasHydrated());

  useEffect(() => {
    const unsubscribe = useConnectionStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    if (useConnectionStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    return unsubscribe;
  }, []);

  return hydrated;
}

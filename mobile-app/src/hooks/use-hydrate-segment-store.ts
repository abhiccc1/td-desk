import { useEffect, useState } from "react";

import { useSegmentStore } from "@/stores/use-segment-store";

export function useHydrateSegmentStore() {
  const [hydrated, setHydrated] = useState(useSegmentStore.persist.hasHydrated());

  useEffect(() => {
    const unsubscribe = useSegmentStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    if (useSegmentStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    return unsubscribe;
  }, []);

  return hydrated;
}

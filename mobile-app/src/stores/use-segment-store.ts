import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { Segment } from "@/lib/instruments";

const STORAGE_KEY = "td-desk-mobile:segment";

type SegmentState = {
  segment: Segment;
  setSegment: (segment: Segment) => void;
};

export const useSegmentStore = create<SegmentState>()(
  persist(
    (set) => ({
      segment: "EQ_IDX",
      setSegment: (segment) => set({ segment }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ segment: state.segment }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as Partial<SegmentState> | undefined)?.segment;
        return {
          ...currentState,
          segment: persisted === "MCX" || persisted === "EQ_IDX" ? persisted : currentState.segment,
        };
      },
    },
  ),
);

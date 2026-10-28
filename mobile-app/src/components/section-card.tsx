import type { PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";

import { palette } from "@/lib/theme";

export function SectionCard({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
  },
});

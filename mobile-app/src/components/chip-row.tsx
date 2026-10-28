import { ScrollView, Pressable, StyleSheet, Text } from "react-native";

import { palette } from "@/lib/theme";

export function ChipRow({
  items,
  selected,
  onSelect,
  labels,
}: {
  items: string[];
  selected: string;
  onSelect: (value: string) => void;
  /** Optional display label per item value; falls back to the value itself. */
  labels?: Record<string, string>;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.container}>
      {items.map((item) => {
        const active = item === selected;
        return (
          <Pressable key={item} style={[styles.chip, active && styles.chipActive]} onPress={() => onSelect(item)}>
            <Text style={[styles.text, active && styles.textActive]}>{labels?.[item] ?? item}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    paddingBottom: 12,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: palette.input,
    borderWidth: 1,
    borderColor: palette.border,
  },
  chipActive: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  text: {
    color: palette.text,
    fontWeight: "600",
  },
  textActive: {
    color: palette.bg,
  },
});

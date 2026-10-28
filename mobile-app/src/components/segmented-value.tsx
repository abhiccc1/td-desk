import { Pressable, StyleSheet, Text, View } from "react-native";

import { palette } from "@/lib/theme";

export function SegmentedValue({
  values,
  selected,
  onSelect,
  dangerValue,
}: {
  values: string[];
  selected: string;
  onSelect: (value: string) => void;
  dangerValue?: string;
}) {
  return (
    <View style={styles.segmentedRow}>
      {values.map((value) => {
        const active = value === selected;
        const danger = active && dangerValue === value;
        return (
          <Pressable
            key={value}
            onPress={() => onSelect(value)}
            style={[
              styles.segmentedButton,
              active && styles.segmentedButtonActive,
              danger && styles.segmentedButtonDanger,
            ]}
          >
            <Text
              style={[
                styles.segmentedText,
                active && styles.segmentedTextActive,
                danger && styles.segmentedTextDanger,
              ]}
            >
              {value}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentedRow: {
    flexDirection: "row",
    gap: 4,
  },
  segmentedButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: palette.border,
    paddingVertical: 7,
    alignItems: "center",
    backgroundColor: "#101a26",
  },
  segmentedButtonActive: {
    backgroundColor: "#132739",
    borderColor: "#2f93d6",
  },
  segmentedButtonDanger: {
    backgroundColor: "#2a1618",
    borderColor: "#d25454",
  },
  segmentedText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700",
  },
  segmentedTextActive: {
    color: "#4ec7ff",
  },
  segmentedTextDanger: {
    color: "#ff7d7d",
  },
});

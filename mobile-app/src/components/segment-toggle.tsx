import { Pressable, StyleSheet, Text, View } from "react-native";

import { SegmentedValue } from "@/components/segmented-value";
import { SEGMENT_LABELS, SEGMENTS, segmentFromLabel, type Segment } from "@/lib/instruments";
import { palette } from "@/lib/theme";

/** NSE+BSE / MCX switch. Renders nothing when the backend exposes no MCX underlyings. */
export function SegmentToggle({
  segment,
  onChange,
  visible,
}: {
  segment: Segment;
  onChange: (segment: Segment) => void;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <View style={styles.toggleWrap}>
      <SegmentedValue
        values={SEGMENTS.map((value) => SEGMENT_LABELS[value])}
        selected={SEGMENT_LABELS[segment]}
        onSelect={(label) => onChange(segmentFromLabel(label))}
      />
    </View>
  );
}

/** Muted, tappable note so items in the inactive segment are never hidden silently. */
export function OtherSegmentHint({
  count,
  noun,
  segment,
  onPress,
}: {
  count: number;
  noun: string;
  segment: Segment;
  onPress: () => void;
}) {
  if (count <= 0) return null;
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.hint}>
      <Text style={styles.hintText}>
        {`${count} ${noun}${count === 1 ? "" : "s"} in ${SEGMENT_LABELS[segment]} · tap to view`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggleWrap: {
    marginBottom: 12,
  },
  hint: {
    alignSelf: "flex-start",
    marginBottom: 10,
  },
  hintText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "600",
  },
});

import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { formatMoney, formatNumber } from "@/lib/format";
import { describePositionInstrument, getPositionIsOpen, getPositionQuantity } from "@/lib/positions";
import { palette } from "@/lib/theme";
import type { Position } from "@/types/api";

export function PositionCard({
  position,
  stopLossTrigger,
  selectionMode,
  selected,
  onPress,
  onLongPress,
}: {
  position: Position;
  stopLossTrigger?: number | null;
  selectionMode: boolean;
  selected: boolean;
  onPress?: (position: Position) => void;
  onLongPress?: (position: Position) => void;
}) {
  const quantity = getPositionQuantity(position);
  const pnl = position.pnl ?? 0;
  const isOpen = getPositionIsOpen(position);
  const instrument = describePositionInstrument(position);
  const quantityLabel = `${quantity > 0 ? "+" : ""}${formatNumber(quantity, 0)} ${Math.abs(quantity) === 1 ? "UNIT" : "UNITS"}`;
  const productLabel = position.productType ?? "NRML";

  return (
    <Pressable
      onPress={() => onPress?.(position)}
      onLongPress={() => onLongPress?.(position)}
      delayLongPress={240}
      style={({ pressed }) => [
        styles.card,
        !isOpen && styles.cardClosed,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {selectionMode ? (
            <Ionicons
              name={selected ? "checkbox" : "square-outline"}
              size={18}
              color={selected ? "#1f8bff" : (isOpen ? palette.muted : "#4d5b6c")}
            />
          ) : null}
          <Text style={styles.quantity}>{quantityLabel}</Text>
        </View>
        <View style={styles.headerRight}>
          {typeof stopLossTrigger === "number" && stopLossTrigger > 0 ? (
            <Tag label={`SL ${formatMoney(stopLossTrigger)}`} tone="sl" />
          ) : null}
          <Text style={styles.product}>{productLabel}</Text>
        </View>
      </View>

      <View style={styles.contractRow}>
        <View style={styles.contractInfo}>
          <Text style={styles.underlying}>{instrument.underlying}</Text>
          {instrument.strike ? <Tag label={instrument.strike} /> : null}
          {instrument.optionType ? (
            <Tag
              label={instrument.optionType === "CE" ? "CALL" : "PUT"}
              tone={instrument.optionType === "CE" ? "call" : "put"}
            />
          ) : null}
          {instrument.expiry ? <Tag label={instrument.expiry} /> : null}
        </View>
        <Text style={[styles.pnl, pnl >= 0 ? styles.pnlPositive : styles.pnlNegative]}>
          {formatMoney(pnl)}
        </Text>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {(position.exchange ?? "NSE").toUpperCase()} • AVG {formatMoney(position.avgPrice ?? 0)}
        </Text>
        <Text style={styles.footerText}>LTP {formatMoney(position.ltp ?? 0)}</Text>
      </View>
    </Pressable>
  );
}

function Tag({ label, tone = "default" }: { label: string; tone?: "default" | "call" | "put" | "sl" }) {
  return (
    <View
      style={[
        styles.tag,
        tone === "call" && styles.tagCall,
        tone === "put" && styles.tagPut,
        tone === "sl" && styles.tagSl,
      ]}
    >
      <Text
        style={[
          styles.tagText,
          tone === "call" && styles.tagTextCall,
          tone === "put" && styles.tagTextPut,
          tone === "sl" && styles.tagTextSl,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#11161d",
    borderBottomWidth: 1,
    borderColor: "#232d3a",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardClosed: {
    opacity: 0.42,
  },
  cardSelected: {
    backgroundColor: "#12202d",
  },
  cardPressed: {
    opacity: 0.92,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  quantity: {
    color: "#93a1b4",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  product: {
    color: "#9ca8b7",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  contractRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  contractInfo: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    flex: 1,
  },
  underlying: {
    color: palette.text,
    fontSize: 16,
    fontWeight: "700",
  },
  tag: {
    backgroundColor: "#2a1f1c",
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  tagCall: {
    backgroundColor: "#123126",
  },
  tagPut: {
    backgroundColor: "#351a1d",
  },
  tagSl: {
    backgroundColor: "#10263d",
  },
  tagText: {
    color: "#ffa168",
    fontSize: 10,
    fontWeight: "700",
  },
  tagTextCall: {
    color: palette.success,
  },
  tagTextPut: {
    color: palette.danger,
  },
  tagTextSl: {
    color: "#7cc4ff",
  },
  pnl: {
    fontSize: 15,
    fontWeight: "800",
  },
  pnlPositive: {
    color: palette.success,
  },
  pnlNegative: {
    color: palette.danger,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  footerText: {
    color: palette.muted,
    fontSize: 11,
  },
});

import { Pressable, StyleSheet, Text, View } from "react-native";

import { formatMoney, formatNumber } from "@/lib/format";
import { palette } from "@/lib/theme";
import type { OptionStrike } from "@/types/api";

export function OptionRow({
  strike,
  onSelectCall,
  onSelectPut,
}: {
  strike: OptionStrike;
  onSelectCall: () => void;
  onSelectPut: () => void;
}) {
  return (
    <View style={styles.row}>
      <ContractCard side="CE" ltp={strike.call?.ltp ?? 0} bid={strike.call?.bid ?? 0} ask={strike.call?.ask ?? 0} onPress={onSelectCall} />
      <View style={styles.strikePill}>
        <Text style={styles.strikeValue}>{formatNumber(strike.strike, 0)}</Text>
      </View>
      <ContractCard side="PE" ltp={strike.put?.ltp ?? 0} bid={strike.put?.bid ?? 0} ask={strike.put?.ask ?? 0} onPress={onSelectPut} />
    </View>
  );
}

function ContractCard({
  side,
  ltp,
  bid,
  ask,
  onPress,
}: {
  side: "CE" | "PE";
  ltp: number;
  bid: number;
  ask: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <Text style={styles.sideLabel}>{side}</Text>
      <Text style={styles.ltp}>{formatMoney(ltp)}</Text>
      <Text style={styles.quote}>B {formatMoney(bid)}</Text>
      <Text style={styles.quote}>A {formatMoney(ask)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  card: {
    flex: 1,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  sideLabel: {
    color: palette.accentSoft,
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 6,
  },
  ltp: {
    color: palette.text,
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 6,
  },
  quote: {
    color: palette.muted,
    fontSize: 12,
  },
  strikePill: {
    width: 82,
    backgroundColor: palette.input,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: palette.border,
  },
  strikeValue: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "700",
  },
});

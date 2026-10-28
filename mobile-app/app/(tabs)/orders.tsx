import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";

import { EmptyState } from "@/components/empty-state";
import { SegmentedValue } from "@/components/segmented-value";
import { Screen } from "@/components/screen";
import { SectionCard } from "@/components/section-card";
import {
  fetchLotSizes,
  lotSizesKey,
  placeOrders,
} from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { unitMultiplierFor } from "@/lib/instruments";
import { getResolvedLotSize, hasKnownLotSize, mergeLotSizes } from "@/lib/lot-sizes";
import { formatStrike } from "@/lib/positions";
import { palette, textStyles } from "@/lib/theme";
import { useActiveSegment } from "@/hooks/use-active-segment";
import { useBasketStore } from "@/stores/use-basket-store";

export default function OrdersScreen() {
  const legs = useBasketStore((state) => state.legs);
  const updateLeg = useBasketStore((state) => state.updateLeg);
  const removeLeg = useBasketStore((state) => state.removeLeg);
  const clearBasket = useBasketStore((state) => state.clearBasket);
  const [submitting, setSubmitting] = useState(false);
  const [lotDrafts, setLotDrafts] = useState<Record<string, string>>({});
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});

  const lotSizesQuery = useQuery({
    queryKey: lotSizesKey,
    queryFn: fetchLotSizes,
  });
  const { underlyings, underlyingMap } = useActiveSegment();
  const lotSizeMap = useMemo(
    () => mergeLotSizes(lotSizesQuery.data, underlyings),
    [lotSizesQuery.data, underlyings],
  );

  const summary = useMemo(() => {
    return legs.reduce((acc, leg) => {
      const lotSize = getResolvedLotSize(leg.underlying, lotSizeMap);
      const quantity = Math.max(1, Math.trunc(leg.lots) || 1) * lotSize;
      acc.quantity += quantity;
      acc.notional += leg.orderType === "L"
        ? quantity * (leg.price ?? 0) * unitMultiplierFor(leg.underlying, underlyingMap)
        : 0;
      return acc;
    }, { quantity: 0, notional: 0 });
  }, [legs, lotSizeMap, underlyingMap]);

  const handleSubmit = async () => {
    if (!legs.length) return;

    for (const leg of legs) {
      if (!hasKnownLotSize(leg.underlying, lotSizeMap)) {
        Alert.alert("Unknown lot size", `Lot size is unavailable for ${leg.underlying}. Refresh lot sizes before placing this basket.`);
        return;
      }
      if ((lotDrafts[leg.id] ?? String(leg.lots)).trim() === "") {
        Alert.alert("Missing lots", `Enter lots for ${leg.underlying} ${leg.strike} ${leg.optionType}.`);
        return;
      }
      if (leg.orderType === "L" && !(Number(leg.price) > 0)) {
        Alert.alert("Missing limit price", `Enter a valid limit price for ${leg.underlying} ${leg.strike} ${leg.optionType}.`);
        return;
      }
      if (leg.orderType === "L" && (priceDrafts[leg.id] ?? "").trim() === "") {
        Alert.alert("Missing limit price", `Enter a valid limit price for ${leg.underlying} ${leg.strike} ${leg.optionType}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const result = await placeOrders(legs.map((leg) => {
        const lotSize = getResolvedLotSize(leg.underlying, lotSizeMap);
        return {
          tradingSymbol: leg.tradingSymbol,
          underlying: leg.underlying,
          expiry: leg.expiry,
          strike: leg.strike,
          optionType: leg.optionType,
          transactionType: leg.transactionType,
          quantity: Math.max(1, Math.trunc(leg.lots) || 1) * lotSize,
          orderType: leg.orderType,
          product: leg.product,
          price: leg.orderType === "L" ? leg.price ?? 0 : 0,
        };
      }));

      const failed = result.filter((item) => !item.success);
      if (failed.length) {
        throw new Error(failed[0]?.error || "One or more basket legs failed");
      }

      clearBasket();
      Alert.alert("Basket submitted", `${formatNumber(result.length, 0)} leg(s) were sent successfully.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Basket failed", message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!legs.length) {
    return (
      <Screen>
        <EmptyState
          title="Basket is empty"
          body="Select call and put legs from the Chain tab using the checkboxes. The selected legs will appear here for review and execution."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.headerRow}>
        <View />
        <Pressable onPress={clearBasket} style={styles.clearButton}>
          <Text style={styles.clearButtonText}>Clear</Text>
        </Pressable>
      </View>

      <SectionCard>
        <View style={styles.summaryRow}>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Legs</Text>
            <Text style={styles.summaryValue}>{formatNumber(legs.length, 0)}</Text>
          </View>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Quantity</Text>
            <Text style={styles.summaryValue}>{formatNumber(summary.quantity, 0)}</Text>
          </View>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Limit Value</Text>
            <Text style={styles.summaryValue}>{summary.notional ? formatMoney(summary.notional) : "Market"}</Text>
          </View>
        </View>
      </SectionCard>

      {legs.map((leg) => {
        const lotSize = getResolvedLotSize(leg.underlying, lotSizeMap);
        const quantity = Math.max(1, Math.trunc(leg.lots) || 1) * lotSize;

        return (
          <View key={leg.id} style={styles.legCard}>
            <View style={styles.legHeader}>
              <View style={styles.legMeta}>
                <Text style={styles.symbolText}>{leg.tradingSymbol || `${leg.underlying} ${leg.expiry}`}</Text>
                <View style={styles.legDetailRow}>
                  <Text style={styles.strikeTag}>{formatStrike(leg.strike)}</Text>
                  <Text style={leg.optionType === "CE" ? styles.callTag : styles.putTag}>
                    {leg.optionType === "CE" ? "CALL" : "PUT"}
                  </Text>
                </View>
              </View>
              <View style={styles.legHeaderRight}>
                <View style={styles.tagRow}>
                  <Text style={styles.expiryTag}>{formatExpiryLabel(leg.expiry)}</Text>
                  <Text style={styles.metaTag}>{leg.product}</Text>
                </View>
                <Pressable onPress={() => removeLeg(leg.id)} style={styles.removeButton}>
                  <Ionicons name="close" size={16} color={palette.muted} />
                </Pressable>
              </View>
            </View>

            <View style={styles.controlRow}>
              <View style={styles.controlBlock}>
                <Text style={styles.fieldLabel}>Side</Text>
                <SegmentedValue
                  values={["BUY", "SELL"]}
                  selected={leg.transactionType === "B" ? "BUY" : "SELL"}
                  onSelect={(value) => updateLeg(leg.id, { transactionType: value === "BUY" ? "B" : "S" })}
                  dangerValue="SELL"
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.fieldLabel}>Product</Text>
                <SegmentedValue
                  values={["NRML", "MIS"]}
                  selected={leg.product}
                  onSelect={(value) => updateLeg(leg.id, { product: value as "NRML" | "MIS" })}
                />
              </View>

              <View style={styles.controlBlock}>
                <Text style={styles.fieldLabel}>Order</Text>
                <SegmentedValue
                  values={["MKT", "L"]}
                  selected={leg.orderType}
                  onSelect={(value) => updateLeg(leg.id, {
                    orderType: value as "MKT" | "L",
                    price: value === "L" ? (leg.price || 0) : 0,
                  })}
                />
              </View>
            </View>

            <View style={styles.doubleRow}>
              <View style={styles.flexBlock}>
                <Text style={styles.fieldLabel}>Lots</Text>
                <TextInput
                  keyboardType="number-pad"
                  value={lotDrafts[leg.id] ?? String(leg.lots)}
                  onChangeText={(value) => {
                    setLotDrafts((current) => ({ ...current, [leg.id]: value }));
                    if (value.trim() === "") return;
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed > 0) {
                      updateLeg(leg.id, { lots: Math.max(1, Math.trunc(parsed)) });
                    }
                  }}
                  style={styles.input}
                  placeholder="1"
                  placeholderTextColor={palette.muted}
                />
              </View>
              {leg.orderType === "L" ? (
                <View style={styles.flexBlock}>
                  <Text style={styles.fieldLabel}>Limit Price</Text>
                  <TextInput
                    keyboardType="decimal-pad"
                    value={priceDrafts[leg.id] ?? (leg.price ? String(leg.price) : "")}
                    onChangeText={(value) => {
                      setPriceDrafts((current) => ({ ...current, [leg.id]: value }));
                      if (value.trim() === "") return;
                      const parsed = Number(value);
                      if (Number.isFinite(parsed) && parsed >= 0) {
                        updateLeg(leg.id, { price: parsed });
                      }
                    }}
                    style={styles.input}
                    placeholder="0"
                    placeholderTextColor={palette.muted}
                  />
                </View>
              ) : (
                <View style={styles.flexBlock}>
                  <Text style={styles.fieldLabel}>Quantity</Text>
                  <View style={styles.readOnlyValue}>
                    <Text style={styles.readOnlyValueText}>{formatNumber(quantity, 0)}</Text>
                  </View>
                </View>
              )}
            </View>

            <View style={styles.footerRow}>
              <Text style={styles.footerLabel}>Lot size {formatNumber(lotSize, 0)}</Text>
              <Text style={styles.footerValue}>Qty {formatNumber(quantity, 0)}</Text>
            </View>

            {leg.orderType === "L" ? (
              <View style={styles.footerRow}>
                <Text style={styles.footerLabel}>Indicative</Text>
                <Text style={styles.footerValue}>
                  {formatMoney(quantity * (leg.price ?? 0) * unitMultiplierFor(leg.underlying, underlyingMap))}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}

      <Pressable
        onPress={handleSubmit}
        disabled={submitting}
        style={({ pressed }) => [
          styles.submitButton,
          pressed && { opacity: 0.9 },
          submitting && { opacity: 0.55 },
        ]}
      >
        <Text style={styles.submitText}>
          {submitting ? "Submitting basket…" : `Place Basket (${formatNumber(legs.length, 0)})`}
        </Text>
      </Pressable>
    </Screen>
  );
}

function formatExpiryLabel(expiry: string) {
  const date = new Date(expiry);
  if (Number.isNaN(date.getTime())) return expiry;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  }).toUpperCase();
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingTop: 10,
    marginBottom: 12,
  },
  clearButton: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearButtonText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryBlock: {
    flex: 1,
  },
  summaryLabel: {
    color: palette.muted,
    fontSize: 10,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  summaryValue: {
    color: palette.text,
    fontSize: 16,
    fontWeight: "800",
  },
  legHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  legMeta: {
    flex: 1,
    paddingRight: 10,
  },
  legDetailRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 6,
    flexWrap: "wrap",
  },
  legHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  legCard: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  tagRow: {
    flexDirection: "row",
    gap: 6,
  },
  expiryTag: {
    color: "#4ec7ff",
    backgroundColor: "#113042",
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  metaTag: {
    color: palette.muted,
    backgroundColor: "#152232",
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  strikeTag: {
    color: palette.text,
    backgroundColor: "#152232",
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  callTag: {
    color: palette.success,
    backgroundColor: "#123126",
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  putTag: {
    color: palette.danger,
    backgroundColor: "#351a1d",
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  removeButton: {
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
  },
  symbolText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "700",
  },
  fieldLabel: {
    ...textStyles.label,
    marginBottom: 5,
    fontSize: 9,
    letterSpacing: 0.35,
  },
  controlRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 10,
  },
  controlBlock: {
    flex: 1,
  },
  doubleRow: {
    flexDirection: "row",
    gap: 10,
  },
  flexBlock: {
    flex: 1,
  },
  input: {
    backgroundColor: palette.input,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: palette.text,
    marginBottom: 10,
    fontSize: 12,
  },
  readOnlyValue: {
    minHeight: 38,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: "#101925",
    paddingHorizontal: 12,
    justifyContent: "center",
    marginBottom: 10,
  },
  readOnlyValueText: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "700",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerLabel: {
    color: palette.muted,
    fontSize: 10,
  },
  footerValue: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "800",
  },
  submitButton: {
    backgroundColor: "#0b0f15",
    borderWidth: 1,
    borderColor: "#1f8bff",
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
    marginBottom: 24,
  },
  submitText: {
    color: "#1f8bff",
    fontSize: 14,
    fontWeight: "800",
  },
});

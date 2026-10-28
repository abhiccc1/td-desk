import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaView } from "react-native-safe-area-context";

import { EmptyState } from "@/components/empty-state";
import { OtherSegmentHint, SegmentToggle } from "@/components/segment-toggle";
import { useActiveSegment } from "@/hooks/use-active-segment";
import { cancelOrder, fetchOrderBook, orderBookKey } from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { orderSegment, otherSegment } from "@/lib/instruments";
import { palette, textStyles } from "@/lib/theme";
import type { OrderBookEntry } from "@/types/api";

type TabMode = "open" | "closed";

export default function OrderBookScreen() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabMode>("open");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const orderBookQuery = useQuery({
    queryKey: orderBookKey,
    queryFn: fetchOrderBook,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  const { segment, setSegment, mcxAvailable, underlyingMap } = useActiveSegment();
  // Without MCX underlyings there is no toggle and nothing is filtered.
  const inSegment = useCallback(
    (order: OrderBookEntry) => !mcxAvailable || orderSegment(order, underlyingMap) === segment,
    [mcxAvailable, segment, underlyingMap],
  );
  const openOrders = orderBookQuery.data?.open;
  const closedOrders = orderBookQuery.data?.closed;
  const segmentOpen = useMemo(() => (openOrders ?? []).filter(inSegment), [inSegment, openOrders]);
  const segmentClosed = useMemo(() => (closedOrders ?? []).filter(inSegment), [closedOrders, inSegment]);
  const tabSource = tab === "open" ? openOrders : closedOrders;
  const hiddenCount = (tabSource?.length ?? 0) - (tab === "open" ? segmentOpen.length : segmentClosed.length);

  const sortedOrders = useMemo(() => (
    [...(tab === "open" ? segmentOpen : segmentClosed)].sort((a, b) => {
      const ta = a.time ?? "";
      const tb = b.time ?? "";
      return tb.localeCompare(ta);
    })
  ), [segmentClosed, segmentOpen, tab]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: orderBookKey });
  }, [queryClient]);

  const handleCancelConfirm = useCallback(async (orderId: string) => {
    setConfirmCancelId(null);
    setCancelling(orderId);
    try {
      await cancelOrder(orderId);
      await queryClient.invalidateQueries({ queryKey: orderBookKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Cancel failed", message);
    } finally {
      setCancelling(null);
    }
  }, [queryClient]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <FlatList
        data={sortedOrders}
        keyExtractor={(item) => item.orderId}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <OrderCard
            order={item}
            isOpen={tab === "open"}
            cancelling={cancelling === item.orderId}
            confirming={confirmCancelId === item.orderId}
            onCancelPress={() => setConfirmCancelId(item.orderId)}
            onCancelConfirm={() => void handleCancelConfirm(item.orderId)}
            onCancelDismiss={() => setConfirmCancelId(null)}
          />
        )}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <SegmentToggle segment={segment} onChange={setSegment} visible={mcxAvailable} />
            <View style={styles.tabRow}>
              <TabChip label="Open" active={tab === "open"} onPress={() => setTab("open")} count={openOrders ? segmentOpen.length : undefined} />
              <TabChip label="Closed" active={tab === "closed"} onPress={() => setTab("closed")} count={closedOrders ? segmentClosed.length : undefined} />
            </View>
            <OtherSegmentHint
              count={hiddenCount}
              noun={`${tab} order`}
              segment={otherSegment(segment)}
              onPress={() => setSegment(otherSegment(segment))}
            />
            {!sortedOrders.length && !orderBookQuery.isLoading ? (
              <EmptyState
                title={`No ${tab} orders`}
                body={tab === "open" ? "No pending orders at the moment." : "No completed or cancelled orders found."}
              />
            ) : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={palette.accent}
            refreshing={orderBookQuery.isRefetching}
            onRefresh={refresh}
          />
        }
      />
    </SafeAreaView>
  );
}

function OrderCard({
  order,
  isOpen,
  cancelling,
  confirming,
  onCancelPress,
  onCancelConfirm,
  onCancelDismiss,
}: {
  order: OrderBookEntry;
  isOpen: boolean;
  cancelling: boolean;
  confirming: boolean;
  onCancelPress: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
}) {
  const symbol = order.tradingSymbol || order.symbol || "—";
  const hasPrice = order.price > 0;
  const hasTrigger = order.triggerPrice > 0;
  const hasAvg = order.avgPrice > 0;
  const filledFraction = order.quantity > 0 ? order.filledQty / order.quantity : 0;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardSymbol} numberOfLines={1}>{symbol}</Text>
        <View style={styles.cardTags}>
          {order.expiry ? <Text style={styles.expiryTag}>{order.expiry}</Text> : null}
          <SideBadge side={order.side} />
          <OrderTypeBadge orderType={order.orderType} />
          {order.productType ? <Text style={styles.metaTag}>{order.productType}</Text> : null}
        </View>
      </View>

      <View style={styles.metricsRow}>
        <Metric label="Qty" value={formatNumber(order.quantity, 0)} />
        <Metric label="Filled" value={formatNumber(order.filledQty, 0)} />
        {hasPrice ? <Metric label="Price" value={formatMoney(order.price)} /> : null}
        {hasTrigger ? <Metric label="Trigger" value={formatMoney(order.triggerPrice)} /> : null}
        {hasAvg ? <Metric label="Avg" value={formatMoney(order.avgPrice)} accent /> : null}
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.cardFooterLeft}>
          {order.status ? <StatusBadge status={order.status} /> : null}
          {order.time ? <Text style={styles.timeText}>{order.time}</Text> : null}
        </View>
        {isOpen ? (
          confirming ? (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmText}>Cancel order?</Text>
              <Pressable onPress={onCancelDismiss} style={styles.confirmNoButton}>
                <Text style={styles.confirmNoText}>No</Text>
              </Pressable>
              <Pressable
                onPress={onCancelConfirm}
                disabled={cancelling}
                style={[styles.confirmYesButton, cancelling && styles.disabledButton]}
              >
                {cancelling
                  ? <ActivityIndicator size="small" color="#ff8787" />
                  : <Text style={styles.confirmYesText}>Yes</Text>}
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={onCancelPress}
              disabled={cancelling}
              style={[styles.cancelButton, cancelling && styles.disabledButton]}
            >
              {cancelling
                ? <ActivityIndicator size="small" color="#ff8787" />
                : <Text style={styles.cancelButtonText}>Cancel</Text>}
            </Pressable>
          )
        ) : null}
      </View>

      {filledFraction > 0 && filledFraction < 1 ? (
        <View style={styles.fillBar}>
          <View style={[styles.fillBarFill, { width: `${Math.round(filledFraction * 100)}%` as `${number}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent && styles.metricValueAccent]}>{value}</Text>
    </View>
  );
}

function SideBadge({ side }: { side: "BUY" | "SELL" }) {
  return (
    <View style={[styles.sideBadge, side === "BUY" ? styles.sideBadgeBuy : styles.sideBadgeSell]}>
      <Text style={[styles.sideBadgeText, side === "BUY" ? styles.sideBadgeTextBuy : styles.sideBadgeTextSell]}>
        {side}
      </Text>
    </View>
  );
}

function OrderTypeBadge({ orderType }: { orderType: string }) {
  return (
    <View style={styles.typeBadge}>
      <Text style={styles.typeBadgeText}>{orderType}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: string }) {
  const upper = status.toUpperCase();
  const isComplete = upper === "COMPLETE" || upper === "FILLED";
  const isRejected = upper === "REJECTED" || upper === "CANCELLED" || upper === "CANCELED";
  return (
    <View style={[styles.statusBadge, isComplete ? styles.statusBadgeComplete : isRejected ? styles.statusBadgeDanger : styles.statusBadgeMuted]}>
      <Text style={[styles.statusBadgeText, isComplete ? styles.statusBadgeTextComplete : isRejected ? styles.statusBadgeTextDanger : styles.statusBadgeTextMuted]}>
        {status}
      </Text>
    </View>
  );
}

function TabChip({ label, active, onPress, count }: { label: string; active: boolean; onPress: () => void; count?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.tabChip, active && styles.tabChipActive]}>
      <Text style={[styles.tabChipText, active && styles.tabChipTextActive]}>{label}</Text>
      {count !== undefined ? (
        <View style={[styles.tabChipBadge, active && styles.tabChipBadgeActive]}>
          <Text style={[styles.tabChipBadgeText, active && styles.tabChipBadgeTextActive]}>
            {formatNumber(count, 0)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  listContent: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 20,
  },
  listHeader: {
    marginBottom: 4,
  },
  tabRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 14,
  },
  tabChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#334151",
    backgroundColor: "#11161d",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  tabChipActive: {
    borderColor: palette.accent,
    backgroundColor: "#0d2035",
  },
  tabChipText: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  tabChipTextActive: {
    color: palette.accent,
  },
  tabChipBadge: {
    backgroundColor: "#1e2e3e",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tabChipBadgeActive: {
    backgroundColor: "#0e2d4a",
  },
  tabChipBadgeText: {
    color: palette.muted,
    fontSize: 9,
    fontWeight: "800",
  },
  tabChipBadgeTextActive: {
    color: palette.accent,
  },
  card: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardSymbol: {
    color: palette.text,
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
    paddingRight: 8,
  },
  cardTags: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
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
  sideBadge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
  },
  sideBadgeBuy: {
    borderColor: "#2f7d4e",
    backgroundColor: "#0d2a1c",
  },
  sideBadgeSell: {
    borderColor: "#9c3737",
    backgroundColor: "#2a1012",
  },
  sideBadgeText: {
    fontSize: 9,
    fontWeight: "800",
  },
  sideBadgeTextBuy: {
    color: "#46d39a",
  },
  sideBadgeTextSell: {
    color: "#ff8787",
  },
  typeBadge: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#2a3a4b",
    backgroundColor: "#10161e",
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  typeBadgeText: {
    color: palette.muted,
    fontSize: 9,
    fontWeight: "800",
  },
  metricsRow: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 10,
  },
  metric: {},
  metricLabel: {
    ...textStyles.label,
    fontSize: 9,
    marginBottom: 3,
  },
  metricValue: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "700",
  },
  metricValueAccent: {
    color: "#46d39a",
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cardFooterLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    flexWrap: "wrap",
  },
  timeText: {
    color: palette.muted,
    fontSize: 10,
  },
  statusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusBadgeComplete: {
    borderColor: "#2f7d4e",
    backgroundColor: "#0d2a1c",
  },
  statusBadgeDanger: {
    borderColor: "#9c3737",
    backgroundColor: "#2a1012",
  },
  statusBadgeMuted: {
    borderColor: "#2a3a4b",
    backgroundColor: "#101925",
  },
  statusBadgeText: {
    fontSize: 9,
    fontWeight: "800",
  },
  statusBadgeTextComplete: {
    color: "#46d39a",
  },
  statusBadgeTextDanger: {
    color: "#ff8787",
  },
  statusBadgeTextMuted: {
    color: palette.muted,
  },
  cancelButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#9c3737",
    backgroundColor: "#2a1012",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelButtonText: {
    color: "#ff8787",
    fontSize: 10,
    fontWeight: "700",
  },
  confirmRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmText: {
    color: palette.muted,
    fontSize: 10,
  },
  confirmNoButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a3a4b",
    backgroundColor: "#101925",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  confirmNoText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700",
  },
  confirmYesButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#9c3737",
    backgroundColor: "#2a1012",
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 36,
    alignItems: "center",
  },
  confirmYesText: {
    color: "#ff8787",
    fontSize: 10,
    fontWeight: "700",
  },
  disabledButton: {
    opacity: 0.5,
  },
  fillBar: {
    marginTop: 10,
    height: 3,
    backgroundColor: "#1a2a3a",
    borderRadius: 999,
    overflow: "hidden",
  },
  fillBarFill: {
    height: 3,
    backgroundColor: "#46d39a",
    borderRadius: 999,
  },
});

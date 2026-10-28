import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { ChipRow } from "@/components/chip-row";
import { EmptyState } from "@/components/empty-state";
import { SegmentToggle } from "@/components/segment-toggle";
import {
  fetchExpiries,
  fetchOptionChain,
  optionChainKey,
  underlyingsKey,
} from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { segmentOf, underlyingPriceLabel } from "@/lib/instruments";
import { formatStrike } from "@/lib/positions";
import { palette, textStyles } from "@/lib/theme";
import { useActiveSegment } from "@/hooks/use-active-segment";
import { useChainSubscription } from "@/hooks/use-chain-subscription";
import { useBasketStore } from "@/stores/use-basket-store";
import { useTradeStore } from "@/stores/use-trade-store";
import type { OptionStrike, TickData } from "@/types/api";

const ROW_HEIGHT = 38;
const ATM_BANNER_HEIGHT = 30;
const INITIAL_WINDOW = 25;
const WINDOW_STEP = 10;

export default function ChainScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<OptionStrike>>(null);
  const centeredKeyRef = useRef("");
  const [aboveWindow, setAboveWindow] = useState(INITIAL_WINDOW);
  const [belowWindow, setBelowWindow] = useState(INITIAL_WINDOW);

  const {
    underlying,
    expiry,
    selectUnderlying,
    selectExpiry,
  } = useTradeStore();
  const legs = useBasketStore((state) => state.legs);
  const toggleLeg = useBasketStore((state) => state.toggleLeg);

  const {
    segment,
    setSegment,
    mcxAvailable,
    underlyings,
    underlyingMap,
    underlyingsQuery,
  } = useActiveSegment();
  const segmentUnderlyings = useMemo(
    () => underlyings.filter((item) => segmentOf(item.exchange) === segment),
    [segment, underlyings],
  );
  const segmentUnderlyingNames = useMemo(
    () => segmentUnderlyings.map((item) => item.name),
    [segmentUnderlyings],
  );
  const underlyingLabels = useMemo(
    () => Object.fromEntries(segmentUnderlyings.map((item) => [item.name, item.displayName || item.name])),
    [segmentUnderlyings],
  );

  const expiriesQuery = useQuery({
    queryKey: ["expiries", underlying],
    queryFn: () => fetchExpiries(underlying),
    enabled: !!underlying,
  });

  const chainQuery = useQuery({
    queryKey: optionChainKey(underlying, expiry),
    queryFn: () => fetchOptionChain(underlying, expiry),
    enabled: !!underlying && !!expiry,
    refetchInterval: 30_000,
  });

  useChainSubscription(underlying, expiry);

  useEffect(() => {
    // Pick the first underlying of the active segment on first load, and
    // re-select when the current one belongs to the other segment.
    if (!segmentUnderlyingNames.length) return;
    if (!underlying || !segmentUnderlyingNames.includes(underlying)) {
      selectUnderlying(segmentUnderlyingNames[0]);
    }
  }, [segmentUnderlyingNames, selectUnderlying, underlying]);

  useEffect(() => {
    if (!expiry && expiriesQuery.data?.length) {
      selectExpiry(expiriesQuery.data[0]);
    }
  }, [expiry, expiriesQuery.data, selectExpiry]);

  useEffect(() => {
    centeredKeyRef.current = "";
    setAboveWindow(INITIAL_WINDOW);
    setBelowWindow(INITIAL_WINDOW);
  }, [underlying, expiry]);

  const chain = chainQuery.data;
  const strikes = chain?.strikes ?? [];
  const spot = chain?.underlyingPrice ?? 0;
  const assetClass = underlyingMap[underlying.toUpperCase()]?.assetClass
    ?? (segmentOf(chain?.exchange) === "MCX" ? "commodity" : "index");
  const priceLabel = underlyingPriceLabel(assetClass);
  const inlinePriceLabel = priceLabel === "Fut" ? "Future price" : "Spot price";
  const futureSymbol = chain?.underlyingFuture?.tradingSymbol ?? "";
  const atmIndex = getAtmIndex(strikes, spot);
  const visibleStart = atmIndex >= 0 ? Math.max(0, atmIndex - aboveWindow) : 0;
  const visibleEnd = atmIndex >= 0
    ? Math.min(strikes.length - 1, atmIndex + belowWindow)
    : Math.min(strikes.length - 1, INITIAL_WINDOW * 2);
  const visibleStrikes = useMemo(
    () => strikes.slice(visibleStart, visibleEnd + 1),
    [strikes, visibleEnd, visibleStart],
  );
  const visibleAtmIndex = atmIndex >= 0 ? atmIndex - visibleStart : -1;
  const activeKey = `${underlying}:${expiry}:${visibleStart}:${visibleEnd}:${visibleAtmIndex}`;
  const selectedLegIds = useMemo(() => new Set(legs.map((leg) => leg.id)), [legs]);

  useEffect(() => {
    if (!visibleStrikes.length || visibleAtmIndex < 0) return;
    if (centeredKeyRef.current === activeKey) return;
    centeredKeyRef.current = activeKey;

    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: visibleAtmIndex,
        animated: false,
        viewPosition: 0.42,
      });
    }, 120);

    return () => clearTimeout(timer);
  }, [activeKey, visibleAtmIndex, visibleStrikes.length]);

  const onToggleStrike = useCallback((strike: OptionStrike, optionType: "CE" | "PE") => {
    toggleLeg({
      underlying,
      expiry,
      strike: strike.strike,
      optionType,
      tradingSymbol: optionType === "CE" ? strike.call?.symbol ?? null : strike.put?.symbol ?? null,
    });
  }, [expiry, toggleLeg, underlying]);

  const onRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: underlyingsKey }),
      underlying
        ? queryClient.invalidateQueries({ queryKey: ["expiries", underlying] })
        : Promise.resolve(),
      underlying && expiry
        ? queryClient.invalidateQueries({ queryKey: optionChainKey(underlying, expiry) })
        : Promise.resolve(),
    ]);
  }, [expiry, queryClient, underlying]);

  const onScrollToIndexFailed = useCallback(() => {
    setTimeout(() => {
      if (visibleAtmIndex >= 0) {
        listRef.current?.scrollToOffset({
          offset: computeItemOffset(visibleAtmIndex, visibleAtmIndex),
          animated: false,
        });
      }
    }, 180);
  }, [visibleAtmIndex]);

  const renderStrikeRow = useCallback(({ item, index }: { item: OptionStrike; index: number }) => (
    <MemoChainRow
      strike={item}
      index={index}
      atmIndex={visibleAtmIndex}
      spot={spot}
      priceLabel={inlinePriceLabel}
      onToggleStrike={onToggleStrike}
      selectedCall={selectedLegIds.has(getBasketLegId({
        tradingSymbol: item.call?.symbol ?? null,
        underlying,
        expiry,
        strike: item.strike,
        optionType: "CE",
      }))}
      selectedPut={selectedLegIds.has(getBasketLegId({
        tradingSymbol: item.put?.symbol ?? null,
        underlying,
        expiry,
        strike: item.strike,
        optionType: "PE",
      }))}
    />
  ), [expiry, inlinePriceLabel, onToggleStrike, selectedLegIds, spot, underlying, visibleAtmIndex]);

  const headerComponent = useMemo(() => (
    <View>
      <View style={styles.controlCard}>
        <View style={styles.expiryRow}>
          <View style={styles.expiryBadge}>
            <Ionicons name="calendar-outline" size={18} color={palette.accent} />
            <Text style={styles.expiryText}>{formatExpiryLabel(expiry)}</Text>
          </View>
        </View>

        <SegmentToggle segment={segment} onChange={setSegment} visible={mcxAvailable} />

        <Text style={styles.sectionLabel}>Underlying</Text>
        <ChipRow
          items={segmentUnderlyingNames}
          labels={underlyingLabels}
          selected={underlying}
          onSelect={selectUnderlying}
        />

        <Text style={styles.sectionLabel}>Expiry</Text>
        <ChipRow
          items={expiriesQuery.data ?? []}
          selected={expiry}
          onSelect={selectExpiry}
        />
      </View>

      {chain ? (
        <View style={styles.marketSummary}>
          <View style={styles.marketSummaryBlock}>
            <Text style={styles.marketSummaryLabel}>{priceLabel}</Text>
            <Text style={styles.marketSummaryValue}>{formatMoney(spot)}</Text>
            {futureSymbol ? (
              <Text style={styles.marketSummarySubtle} numberOfLines={1}>{futureSymbol}</Text>
            ) : null}
          </View>
          <View style={styles.marketSummaryBlock}>
            <Text style={styles.marketSummaryLabel}>ATM</Text>
            <Text style={styles.marketSummaryValue}>
              {atmIndex >= 0 ? formatStrike(strikes[atmIndex]?.strike ?? 0) : "n/a"}
            </Text>
          </View>
          <View style={styles.marketSummaryBlock}>
            <Text style={styles.marketSummaryLabel}>Visible</Text>
            <Text style={styles.marketSummaryValue}>
              {formatNumber(visibleStrikes.length, 0)}/{formatNumber(strikes.length, 0)}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.tableHeader}>
        <View style={styles.sideHeader}>
          <Text style={styles.sideTitle}>CALL</Text>
          <Text style={styles.sideMetric}>LTP</Text>
        </View>
        <View style={styles.strikeHeader}>
          <Text style={styles.strikeTitle}>STRIKE</Text>
        </View>
        <View style={[styles.sideHeader, styles.sideHeaderRight]}>
          <Text style={styles.sideTitle}>PUT</Text>
          <Text style={styles.sideMetric}>LTP</Text>
        </View>
      </View>

      {visibleStart > 0 ? (
        <Pressable style={styles.loadMoreButton} onPress={() => setAboveWindow((value) => value + WINDOW_STEP)}>
          <Text style={styles.loadMoreText}>Load 10 more strikes above</Text>
        </Pressable>
      ) : null}
    </View>
  ), [
    atmIndex,
    chain,
    expiry,
    expiriesQuery.data,
    futureSymbol,
    mcxAvailable,
    priceLabel,
    segment,
    segmentUnderlyingNames,
    selectExpiry,
    selectUnderlying,
    setSegment,
    spot,
    strikes,
    underlying,
    underlyingLabels,
    visibleStart,
    visibleStrikes.length,
  ]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <FlatList
        ref={listRef}
        data={visibleStrikes}
        keyExtractor={(item) => String(item.strike)}
        renderItem={renderStrikeRow}
        onScrollToIndexFailed={onScrollToIndexFailed}
        ListHeaderComponent={headerComponent}
        ListEmptyComponent={
          chainQuery.isLoading ? (
            <View style={styles.loader}>
              <ActivityIndicator color={palette.accent} />
              <Text style={textStyles.subtle}>Loading option chain…</Text>
            </View>
          ) : (
            <EmptyState
              title="No chain data yet"
              body="The feed may still be warming up. Keep the backend running and refresh once an expiry is selected."
            />
          )
        }
        ListFooterComponent={
          <View>
            {visibleEnd < strikes.length - 1 ? (
              <Pressable style={styles.loadMoreButton} onPress={() => setBelowWindow((value) => value + WINDOW_STEP)}>
                <Text style={styles.loadMoreText}>Load 10 more strikes below</Text>
              </Pressable>
            ) : null}
            <View style={{ height: 160 }} />
          </View>
        }
        contentContainerStyle={styles.listContent}
        initialNumToRender={18}
        maxToRenderPerBatch={20}
        windowSize={7}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        getItemLayout={(_, index) => ({
          length: index === visibleAtmIndex ? ROW_HEIGHT + ATM_BANNER_HEIGHT : ROW_HEIGHT,
          offset: computeItemOffset(index, visibleAtmIndex),
          index,
        })}
        refreshControl={
          <RefreshControl
            tintColor={palette.accent}
            refreshing={chainQuery.isRefetching || underlyingsQuery.isRefetching}
            onRefresh={onRefresh}
          />
        }
      />
      <View style={styles.bottomActionWrap} pointerEvents="box-none">
        <Pressable
          onPress={() => router.navigate("/(tabs)/orders")}
          style={({ pressed }) => [
            styles.bottomActionButton,
            !legs.length && styles.bottomActionButtonDisabled,
            pressed && legs.length ? { opacity: 0.92 } : null,
          ]}
        >
          <View style={styles.bottomActionSection}>
            <Ionicons name="add-circle" size={18} color={legs.length ? "#1f8bff" : palette.muted} />
            <Text style={[styles.bottomActionText, !legs.length && styles.bottomActionTextDisabled]}>
              Basket Option
            </Text>
          </View>
          <View style={styles.bottomActionDivider} />
          <Text style={[styles.bottomActionCount, !legs.length && styles.bottomActionTextDisabled]}>
            {formatNumber(legs.length, 0)} selected
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function ChainRow({
  strike,
  index,
  atmIndex,
  spot,
  priceLabel,
  onToggleStrike,
  selectedCall,
  selectedPut,
}: {
  strike: OptionStrike;
  index: number;
  atmIndex: number;
  spot: number;
  priceLabel: string;
  onToggleStrike: (strike: OptionStrike, optionType: "CE" | "PE") => void;
  selectedCall: boolean;
  selectedPut: boolean;
}) {
  const isAtm = index === atmIndex;
  const onToggleCall = useCallback(() => onToggleStrike(strike, "CE"), [onToggleStrike, strike]);
  const onTogglePut = useCallback(() => onToggleStrike(strike, "PE"), [onToggleStrike, strike]);

  return (
    <View style={styles.rowGroup}>
      <View style={[styles.row, isAtm && styles.rowAtm]}>
        <MemoOptionSideCell
          side="call"
          tick={strike.call}
          active={isAtm}
          selected={selectedCall}
          onToggle={onToggleCall}
        />

        <View style={[styles.strikeCell, isAtm && styles.strikeCellAtm]}>
          <Text style={[styles.strikeCellText, isAtm && styles.strikeCellTextAtm]}>
            {formatStrike(strike.strike)}
          </Text>
          {isAtm ? <View style={styles.atmDot} /> : null}
        </View>

        <MemoOptionSideCell
          side="put"
          tick={strike.put}
          active={isAtm}
          selected={selectedPut}
          onToggle={onTogglePut}
        />
      </View>

      {isAtm ? (
        <View style={styles.inlineSpotWrap}>
          <View style={styles.inlineSpotLine} />
          <View style={styles.inlineSpotBanner}>
            <Text style={styles.inlineSpotLabel}>{priceLabel}</Text>
            <Text style={styles.inlineSpotValue}>{formatMoney(spot)}</Text>
            <Text style={styles.inlineSpotSubtle}>
              ATM {formatStrike(strike.strike)}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const MemoChainRow = memo(ChainRow, (prev, next) => {
  const prevIsAtm = prev.index === prev.atmIndex;
  const nextIsAtm = next.index === next.atmIndex;

  return (
    prev.index === next.index
    && prev.atmIndex === next.atmIndex
    && prev.spot === next.spot
    && prev.priceLabel === next.priceLabel
    && prev.selectedCall === next.selectedCall
    && prev.selectedPut === next.selectedPut
    && prev.strike.strike === next.strike.strike
    && ticksEqual(prev.strike.call, next.strike.call)
    && ticksEqual(prev.strike.put, next.strike.put)
    && prevIsAtm === nextIsAtm
  );
});

function OptionSideCell({
  side,
  tick,
  active,
  selected,
  onToggle,
}: {
  side: "call" | "put";
  tick: TickData | null;
  active: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const ltp = tick?.ltp ?? 0;

  return (
    <View style={[
      styles.optionCell,
      side === "call" ? styles.callCell : styles.putCell,
      active && styles.optionCellActive,
      selected && styles.optionCellSelected,
    ]}>
      <View style={[styles.optionContent, side === "put" && styles.optionContentReverse]}>
        <Pressable onPress={onToggle} hitSlop={10} style={styles.checkboxButton}>
          <Ionicons
            name={selected ? "checkbox" : "square-outline"}
            size={14}
            color={selected ? "#1f8bff" : palette.muted}
          />
        </Pressable>
        <Text style={styles.optionPrimary}>
          {formatMoney(ltp)}
        </Text>
      </View>
    </View>
  );
}

const MemoOptionSideCell = memo(OptionSideCell, (prev, next) => (
  prev.side === next.side
  && prev.active === next.active
  && prev.selected === next.selected
  && ticksEqual(prev.tick, next.tick)
));

function getBasketLegId({
  tradingSymbol,
  underlying,
  expiry,
  strike,
  optionType,
}: {
  tradingSymbol?: string | null;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
}) {
  return tradingSymbol || `${underlying}:${expiry}:${strike}:${optionType}`;
}

function ticksEqual(a: TickData | null, b: TickData | null) {
  if (a === b) return true;
  if (!a || !b) return a === b;
  return (
    a.symbol === b.symbol
    && a.ltp === b.ltp
    && a.oi === b.oi
    && a.bid === b.bid
    && a.ask === b.ask
    && a.timestamp === b.timestamp
  );
}

function computeItemOffset(index: number, atmIndex: number) {
  if (atmIndex < 0) return index * ROW_HEIGHT;
  if (index <= atmIndex) return index * ROW_HEIGHT;
  return index * ROW_HEIGHT + ATM_BANNER_HEIGHT;
}

function getAtmIndex(strikes: OptionStrike[], spot: number) {
  if (!strikes.length || !spot) return -1;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < strikes.length; i += 1) {
    const distance = Math.abs(strikes[i].strike - spot);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  return nearestIndex;
}

function formatExpiryLabel(expiry: string) {
  if (!expiry) return "Select expiry";
  const date = new Date(expiry);
  if (Number.isNaN(date.getTime())) return expiry;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  }).toUpperCase();
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#0a0f15",
  },
  listContent: {
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  controlCard: {
    backgroundColor: "#0f151c",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#1f2b38",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 12,
  },
  expiryRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 12,
  },
  expiryBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  expiryText: {
    color: palette.accent,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  sectionLabel: {
    color: "#6e7e90",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  marketSummary: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 18,
    backgroundColor: "#0b1117",
  },
  marketSummaryBlock: {
    flex: 1,
  },
  marketSummaryLabel: {
    color: "#738395",
    fontSize: 10,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  marketSummaryValue: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "800",
  },
  marketSummarySubtle: {
    color: palette.muted,
    fontSize: 10,
    marginTop: 3,
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 0,
    paddingTop: 5,
    paddingBottom: 6,
    backgroundColor: "#0b1016",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#202c39",
  },
  sideHeader: {
    flex: 1,
    paddingHorizontal: 12,
  },
  sideHeaderRight: {
    alignItems: "flex-end",
  },
  sideTitle: {
    color: "#11a4ff",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 3,
  },
  sideMetric: {
    color: "#8b98a8",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
  },
  strikeHeader: {
    width: 84,
    alignItems: "center",
  },
  strikeTitle: {
    color: "#8b98a8",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.3,
  },
  row: {
    flexDirection: "row",
    height: ROW_HEIGHT,
    backgroundColor: "#0f141b",
    borderBottomWidth: 1,
    borderColor: "#202b37",
  },
  rowGroup: {
    backgroundColor: "#0f141b",
  },
  rowAtm: {
    backgroundColor: "#101722",
  },
  optionCell: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: "center",
    overflow: "hidden",
  },
  optionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  optionContentReverse: {
    flexDirection: "row-reverse",
  },
  optionCellActive: {
    backgroundColor: "#17202b",
  },
  optionCellSelected: {
    backgroundColor: "#132739",
  },
  callCell: {
    borderRightWidth: 1,
    borderColor: "#243140",
  },
  putCell: {
    borderLeftWidth: 1,
    borderColor: "#243140",
    alignItems: "flex-end",
  },
  strikeCell: {
    width: 84,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0d1218",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: "#273341",
  },
  strikeCellAtm: {
    backgroundColor: "#111923",
  },
  strikeCellText: {
    color: palette.text,
    fontSize: 13,
    fontWeight: "700",
  },
  strikeCellTextAtm: {
    color: "#7ed0ff",
  },
  atmDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: palette.accent,
    marginTop: 4,
  },
  checkboxButton: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  optionPrimary: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "800",
    flexShrink: 1,
  },
  loader: {
    paddingVertical: 36,
    alignItems: "center",
    gap: 12,
  },
  loadMoreButton: {
    marginHorizontal: 18,
    marginVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#21415d",
    backgroundColor: "#0d1620",
    paddingVertical: 12,
    alignItems: "center",
  },
  loadMoreText: {
    color: "#58b9ff",
    fontSize: 12,
    fontWeight: "700",
  },
  inlineSpotWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    height: ATM_BANNER_HEIGHT,
    backgroundColor: "#0f141b",
    marginTop: -1,
    marginBottom: 2,
  },
  inlineSpotLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 14,
    height: 2,
    backgroundColor: "#119dff",
    opacity: 0.9,
  },
  inlineSpotBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(7, 13, 20, 0.98)",
    borderWidth: 2,
    borderColor: "#119dff",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  inlineSpotLabel: {
    color: "#11a4ff",
    fontSize: 10,
    fontWeight: "700",
  },
  inlineSpotValue: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "800",
  },
  inlineSpotSubtle: {
    color: "#ff7a7a",
    fontSize: 10,
    fontWeight: "700",
  },
  bottomActionWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: Platform.select({ ios: 18, default: 14 }),
    paddingHorizontal: 18,
  },
  bottomActionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#2f93d6",
    backgroundColor: "#02070d",
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  bottomActionButtonDisabled: {
    borderColor: palette.border,
    backgroundColor: "#09121b",
  },
  bottomActionSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  bottomActionText: {
    color: "#1f8bff",
    fontSize: 13,
    fontWeight: "800",
  },
  bottomActionTextDisabled: {
    color: palette.muted,
  },
  bottomActionDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: "#1f2b38",
    marginHorizontal: 14,
  },
  bottomActionCount: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "700",
    minWidth: 84,
    textAlign: "right",
  },
});

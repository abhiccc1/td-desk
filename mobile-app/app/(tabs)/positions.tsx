import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { EmptyState } from "@/components/empty-state";
import { PositionCard } from "@/components/position-card";
import { OtherSegmentHint, SegmentToggle } from "@/components/segment-toggle";
import {
  cancelOrder,
  fetchOrderBook,
  fetchLotSizes,
  fetchPositions,
  lotSizesKey,
  modifyOrder,
  orderBookKey,
  placeOrders,
  positionsKey,
} from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { otherSegment, positionSegment, positionValueMultiplier } from "@/lib/instruments";
import { mergeLotSizes } from "@/lib/lot-sizes";
import {
  describePositionInstrument,
  getPositionIsOpen,
  getPositionQuantity,
  normalizeExpiryForOrder,
  normalizeOptionType,
} from "@/lib/positions";
import { palette, textStyles } from "@/lib/theme";
import { useActiveSegment } from "@/hooks/use-active-segment";
import { usePositionsSubscription } from "@/hooks/use-positions-subscription";
import type { OrderBookEntry, PlaceOrderLeg, Position } from "@/types/api";

type FilterMode = "all" | "open" | "closed";
type ModifyMode = "exit" | "add" | "sl";
type PositionOrderType = "MKT" | "L" | "SL";
type ProductType = "NRML" | "MIS";
type ExistingStopLossDraft = Pick<
  OrderBookEntry,
  "orderId"
  | "tradingSymbol"
  | "exchangeSegment"
  | "instrumentToken"
  | "quantity"
  | "triggerPrice"
  | "price"
  | "productType"
  | "validity"
  | "disclosedQty"
  | "side"
  | "orderType"
>;
type ModifyDraft = {
  product: ProductType;
  orderType: PositionOrderType;
  lotsText: string;
  priceText: string;
  triggerText: string;
  existingStopLoss?: ExistingStopLossDraft | null;
};

export default function PositionsScreen() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [modifyModalOpen, setModifyModalOpen] = useState(false);
  const [modifyMode, setModifyMode] = useState<ModifyMode>("exit");
  const [modifyDrafts, setModifyDrafts] = useState<Record<string, ModifyDraft>>({});
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [confirmCancelSymbol, setConfirmCancelSymbol] = useState<string | null>(null);

  const positionsQuery = useQuery({
    queryKey: positionsKey,
    queryFn: fetchPositions,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });
  const lotSizesQuery = useQuery({
    queryKey: lotSizesKey,
    queryFn: fetchLotSizes,
  });
  const orderBookQuery = useQuery({
    queryKey: orderBookKey,
    queryFn: fetchOrderBook,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });

  const { segment, setSegment, mcxAvailable, underlyings, underlyingMap } = useActiveSegment();
  const lotSizeMap = useMemo(
    () => mergeLotSizes(lotSizesQuery.data, underlyings),
    [lotSizesQuery.data, underlyings],
  );

  const allPositions = positionsQuery.data?.positions;
  const positions = useMemo(() => allPositions ?? [], [allPositions]);
  // Live ticks are applied to every position (both segments) so switching is instant.
  usePositionsSubscription(positions, underlyingMap);

  // Without MCX underlyings there is no toggle and nothing is filtered (NSE/BSE unchanged).
  const segmentPositions = useMemo(
    () => (mcxAvailable ? positions.filter((position) => positionSegment(position) === segment) : positions),
    [mcxAvailable, positions, segment],
  );
  const hiddenOpenCount = mcxAvailable
    ? positions.filter((position) => positionSegment(position) !== segment && getPositionIsOpen(position)).length
    : 0;

  const selectionMode = selectedSymbols.length > 0;
  const realizedPnl = segmentPositions.length === positions.length
    ? positionsQuery.data?.realizedPnl ?? 0
    : sumRealizedPnl(segmentPositions);
  const totalPnl = segmentPositions.reduce((sum, position) => sum + (position.pnl || 0), 0);
  const unrealizedPnl = totalPnl - realizedPnl;
  const openPositions = segmentPositions.filter((position) => getPositionIsOpen(position));
  const stopLossBySymbol = useMemo(() => {
    const map = new Map<string, OrderBookEntry[]>();

    for (const order of orderBookQuery.data?.open ?? []) {
      if (order.orderType !== "SL" && order.orderType !== "SL-M") continue;

      const symbolKey = order.tradingSymbol || order.symbol;
      if (!symbolKey) continue;

      const current = map.get(symbolKey) ?? [];
      current.push(order);
      map.set(symbolKey, current);
    }

    return map;
  }, [orderBookQuery.data?.open]);

  const filteredPositions = useMemo(() => {
    const normalizedQuery = search.trim().toLowerCase();
    const matched = segmentPositions.filter((position) => {
      const isOpen = getPositionIsOpen(position);
      if (filterMode === "open" && !isOpen) return false;
      if (filterMode === "closed" && isOpen) return false;

      if (!normalizedQuery) return true;
      const haystack = [
        position.symbol,
        position.tradingSymbol,
        position.exchange,
        position.optionType,
        position.expiry,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    return [...matched].sort((a, b) => {
      const aOpen = getPositionIsOpen(a);
      const bOpen = getPositionIsOpen(b);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [filterMode, search, segmentPositions]);

  // Only positions visible in the active segment can be acted on.
  const selectedOpenPositions = useMemo(
    () => segmentPositions.filter((position) => selectedSymbols.includes(position.symbol) && getPositionIsOpen(position)),
    [segmentPositions, selectedSymbols],
  );

  const refreshPositions = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: positionsKey });
  }, [queryClient]);

  const clearSelection = useCallback(() => {
    if (actionSubmitting) return;
    setSelectedSymbols([]);
    setModifyModalOpen(false);
    setModifyMode("exit");
    setModifyDrafts({});
  }, [actionSubmitting]);

  const toggleSelection = useCallback((position: Position) => {
    if (!getPositionIsOpen(position)) return;
    setSelectedSymbols((current) => (
      current.includes(position.symbol)
        ? current.filter((symbol) => symbol !== position.symbol)
        : [...current, position.symbol]
    ));
  }, []);

  const handleCardPress = useCallback((position: Position) => {
    if (!selectionMode) return;
    toggleSelection(position);
  }, [selectionMode, toggleSelection]);

  const handleCardLongPress = useCallback((position: Position) => {
    if (!getPositionIsOpen(position)) return;
    setSelectedSymbols((current) => (
      current.includes(position.symbol) ? current : [...current, position.symbol]
    ));
  }, []);

  const updateDraft = useCallback((symbol: string, patch: Partial<ModifyDraft>) => {
    setModifyDrafts((current) => ({
      ...current,
      [symbol]: {
        ...current[symbol],
        ...patch,
      },
    }));
  }, []);

  const openModifyDrawer = useCallback(() => {
    if (!selectedOpenPositions.length) return;
    setModifyMode("exit");
    setModifyDrafts(buildInitialModifyDrafts(selectedOpenPositions, "exit", lotSizeMap));
    setModifyModalOpen(true);
  }, [lotSizeMap, selectedOpenPositions]);

  const openStopLossDrawer = useCallback(() => {
    if (!selectedOpenPositions.length) return;
    setModifyMode("sl");
    setModifyDrafts(buildInitialModifyDrafts(selectedOpenPositions, "sl", lotSizeMap, stopLossBySymbol));
    setModifyModalOpen(true);
  }, [lotSizeMap, selectedOpenPositions, stopLossBySymbol]);

  const confirmSquareOffSelection = useCallback(() => {
    if (!selectedOpenPositions.length) return;
    Alert.alert(
      "Square Off Selected",
      `Exit ${formatNumber(selectedOpenPositions.length, 0)} selected position(s) at market?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Square Off",
          style: "destructive",
          onPress: () => {
            void submitSquareOffSelection(
              selectedOpenPositions,
              stopLossBySymbol,
              lotSizeMap,
              refreshPositions,
              clearSelection,
              setActionSubmitting,
              () => queryClient.invalidateQueries({ queryKey: orderBookKey }),
            );
          },
        },
      ],
    );
  }, [clearSelection, lotSizeMap, queryClient, refreshPositions, selectedOpenPositions, stopLossBySymbol]);

  const executeCancelStopLoss = useCallback(async (orderId: string) => {
    setConfirmCancelSymbol(null);
    setActionSubmitting(true);
    try {
      await cancelOrder(orderId);
      await queryClient.invalidateQueries({ queryKey: orderBookKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Cancel failed", message);
    } finally {
      setActionSubmitting(false);
    }
  }, [queryClient]);

  const submitModifySelection = useCallback(async () => {
    if (!selectedOpenPositions.length) return;

    const validationError = validateModifySelection(selectedOpenPositions, modifyDrafts, modifyMode, lotSizeMap);
    if (validationError) {
      Alert.alert(validationError.title, validationError.message);
      return;
    }

    const orders = selectedOpenPositions.map((position) => buildPositionOrder({
      position,
      mode: modifyMode,
      draft: modifyDrafts[position.symbol],
      lotSizeMap,
    }));

    if (orders.some((order) => !order)) {
      Alert.alert("Modify unavailable", "One or more selected positions are missing instrument details required to place an order.");
      return;
    }

    setActionSubmitting(true);
    try {
      let changeCount = 0;
      if (modifyMode === "sl") {
        const modifyRequests: Promise<unknown>[] = [];
        const createRequests: PlaceOrderLeg[] = [];

        selectedOpenPositions.forEach((position) => {
          const draft = modifyDrafts[position.symbol];
          const existingStopLoss = draft?.existingStopLoss ?? null;
          if (!draft) return;
          const canModifyExistingStopLoss = hasUsableOrderId(existingStopLoss?.orderId);

          if (existingStopLoss && canModifyExistingStopLoss) {
            const quantity = Math.max(1, Math.trunc(Number(draft.lotsText) || 0)) * getPositionLotSize(position, lotSizeMap);
            const triggerPrice = Number(draft.triggerText) || 0;
            const limitPrice = Number(draft.priceText) || 0;
            const transactionType = getPositionQuantity(position) > 0 ? "S" : "B";

            if (isExistingStopLossUnchanged(existingStopLoss, {
              quantity,
              triggerPrice,
              limitPrice,
              product: draft.product,
              transactionType,
            })) {
              return;
            }

            changeCount += 1;
            modifyRequests.push(
              modifyOrder(existingStopLoss.orderId, {
                quantity,
                price: limitPrice,
                trigger_price: triggerPrice,
                disclosed_quantity: existingStopLoss.disclosedQty ?? 0,
                validity: existingStopLoss.validity || "DAY",
                order_type: "SL",
                trading_symbol: existingStopLoss.tradingSymbol || position.tradingSymbol || position.symbol,
                transaction_type: transactionType,
                // Omit when unknown: the backend derives it from the trading symbol.
                exchange_segment: existingStopLoss.exchangeSegment || undefined,
                product: draft.product,
                instrument_token: existingStopLoss.instrumentToken || "",
              }),
            );
            return;
          }

          const order = buildPositionOrder({
            position,
            mode: modifyMode,
            draft,
            lotSizeMap,
          });
          if (order) {
            changeCount += 1;
            createRequests.push(order);
          }
        });

        if (!changeCount) {
          Alert.alert("No changes", "Selected positions already have the same stop-loss values.");
          return;
        }

        await Promise.all(modifyRequests);
        if (createRequests.length) {
          const created = await placeOrders(createRequests);
          const failures = created.filter((item) => !item.success);
          if (failures.length) {
            throw new Error(failures.map((item) => `Leg ${item.index + 1}: ${item.error}`).join("; "));
          }
        }
      } else {
        const results = await placeOrders(orders as PlaceOrderLeg[]);
        const failures = results.filter((item) => !item.success);
        if (failures.length) {
          throw new Error(failures.map((item) => `Leg ${item.index + 1}: ${item.error}`).join("; "));
        }
      }
      setModifyModalOpen(false);

      let slNote = "";
      if (modifyMode === "exit" || modifyMode === "add") {
        const targetQtyBySymbol = new Map(
          selectedOpenPositions.map((position) => {
            const draft = modifyDrafts[position.symbol];
            const lotSize = getPositionLotSize(position, lotSizeMap);
            const openQty = Math.abs(getPositionQuantity(position));
            const deltaQty = Math.max(1, Math.trunc(Number(draft?.lotsText) || 0)) * lotSize;
            const targetQty = modifyMode === "exit"
              ? Math.max(0, openQty - deltaQty)
              : openQty + deltaQty;
            return [position.symbol, targetQty];
          }),
        );
        const [slResult] = await Promise.all([
          syncSlToPositionQty(selectedOpenPositions, targetQtyBySymbol, stopLossBySymbol),
          refreshPositions(),
          queryClient.invalidateQueries({ queryKey: orderBookKey }),
        ]);
        slNote = formatSlAdjustmentNote(slResult);
      } else {
        await Promise.all([
          refreshPositions(),
          queryClient.invalidateQueries({ queryKey: orderBookKey }),
        ]);
      }

      clearSelection();
      Alert.alert(
        modifyMode === "sl" ? "Stop loss submitted" : "Orders submitted",
        `${formatNumber(changeCount || orders.length, 0)} ${modifyMode === "sl" ? "stop-loss" : "modify"} order(s) sent.${slNote}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert(modifyMode === "sl" ? "Add SL failed" : "Modify failed", message);
    } finally {
      setActionSubmitting(false);
    }
  }, [clearSelection, lotSizeMap, modifyDrafts, modifyMode, queryClient, refreshPositions, selectedOpenPositions, stopLossBySymbol]);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <FlatList
        data={filteredPositions}
        renderItem={({ item }) => (
          <PositionCard
            position={item}
            stopLossTrigger={getPositionStopLossTrigger(item, stopLossBySymbol)}
            selectionMode={selectionMode}
            selected={selectedSymbols.includes(item.symbol)}
            onPress={handleCardPress}
            onLongPress={handleCardLongPress}
          />
        )}
        keyExtractor={(item) => `${item.symbol}-${item.netQty ?? item.quantity ?? 0}`}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <View style={styles.pnlCard}>
              <View style={styles.pnlHeader}>
                <Text style={styles.pnlHeaderLabel}>Profit/Loss</Text>
                <Text style={[styles.pnlHeaderValue, totalPnl >= 0 ? styles.positive : styles.negative]}>
                  {formatMoney(totalPnl)}
                </Text>
              </View>

              <View style={styles.pnlBreakdown}>
                <Metric title="Realised P/L" value={formatMoney(realizedPnl)} tone={realizedPnl} />
                <Metric title="Unrealised P/L" value={formatMoney(unrealizedPnl)} tone={unrealizedPnl} />
                <Metric title="Open positions" value={formatNumber(openPositions.length, 0)} />
              </View>
            </View>

            <SegmentToggle
              segment={segment}
              onChange={(next) => {
                if (next !== segment) clearSelection();
                setSegment(next);
              }}
              visible={mcxAvailable}
            />
            <OtherSegmentHint
              count={hiddenOpenCount}
              noun="open position"
              segment={otherSegment(segment)}
              onPress={() => {
                clearSelection();
                setSegment(otherSegment(segment));
              }}
            />

            <View style={styles.actionRow}>
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={16} color="#758496" />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search in positions"
                  placeholderTextColor="#758496"
                  style={styles.searchInput}
                />
              </View>
            </View>

            <View style={styles.filterRow}>
              <FilterChip label="All" active={filterMode === "all"} onPress={() => setFilterMode("all")} />
              <FilterChip label="Open" active={filterMode === "open"} onPress={() => setFilterMode("open")} />
              <FilterChip label="Closed" active={filterMode === "closed"} onPress={() => setFilterMode("closed")} />
            </View>

            {selectionMode ? (
              <View style={styles.selectionBar}>
                <View>
                  <Text style={styles.selectionCount}>
                    {formatNumber(selectedOpenPositions.length, 0)}/{formatNumber(openPositions.length, 0)} Selected
                  </Text>
                </View>
                <View style={styles.selectionActions}>
                  <Pressable
                    onPress={openStopLossDrawer}
                    disabled={!selectedOpenPositions.length || actionSubmitting}
                    style={[styles.selectionButton, styles.selectionButtonInfo, (!selectedOpenPositions.length || actionSubmitting) && styles.selectionButtonDisabled]}
                  >
                    <Text style={[styles.selectionButtonText, styles.selectionButtonTextInfo]}>Add SL</Text>
                  </Pressable>
                  <Pressable
                    onPress={openModifyDrawer}
                    disabled={!selectedOpenPositions.length || actionSubmitting}
                    style={[styles.selectionButton, styles.selectionButtonAmber, (!selectedOpenPositions.length || actionSubmitting) && styles.selectionButtonDisabled]}
                  >
                    <Text style={[styles.selectionButtonText, styles.selectionButtonTextAmber]}>Modify</Text>
                  </Pressable>
                  <Pressable
                    onPress={confirmSquareOffSelection}
                    disabled={!selectedOpenPositions.length || actionSubmitting}
                    style={[styles.selectionButton, styles.selectionButtonDanger, (!selectedOpenPositions.length || actionSubmitting) && styles.selectionButtonDisabled]}
                  >
                    <Text style={[styles.selectionButtonText, styles.selectionButtonTextDanger]}>Square Off</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {!filteredPositions.length ? (
              <EmptyState
                title="No positions"
                body={segmentPositions.length ? "No positions match the current search or filter." : "If you are authenticated and still seeing this, verify the backend session and API URL in Settings."}
              />
            ) : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={palette.accent}
            refreshing={positionsQuery.isRefetching || actionSubmitting}
            onRefresh={refreshPositions}
          />
        }
      />

      <Modal
        visible={modifyModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!actionSubmitting) setModifyModalOpen(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => {
            if (!actionSubmitting) setModifyModalOpen(false);
          }} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderMain}>
                <Text style={styles.modalTitle}>{modifyMode === "sl" ? "Add Stop Loss" : "Modify Positions"}</Text>
                <Text style={styles.modalSubtitle}>{formatNumber(selectedOpenPositions.length, 0)} selected leg(s)</Text>
              </View>
              <Pressable
                onPress={() => {
                  if (!actionSubmitting) setModifyModalOpen(false);
                }}
                style={styles.modalCloseButton}
              >
                <Ionicons name="close" size={20} color={palette.muted} />
              </Pressable>
            </View>

            {modifyMode !== "sl" ? (
              <View style={styles.modalSection}>
                <Text style={styles.modalLabel}>Action</Text>
                <View style={styles.modalSegmented}>
                  <SegmentedButton
                    label="Partial Exit"
                    active={modifyMode === "exit"}
                    onPress={() => setModifyMode("exit")}
                  />
                  <SegmentedButton
                    label="Add More"
                    active={modifyMode === "add"}
                    onPress={() => setModifyMode("add")}
                  />
                </View>
              </View>
            ) : null}

            <FlatList
              data={selectedOpenPositions}
              keyExtractor={(item) => item.symbol}
              style={styles.modifyList}
              contentContainerStyle={styles.modifyListContent}
              renderItem={({ item }) => {
                const draft = modifyDrafts[item.symbol];
                const instrument = describePositionInstrument(item);
                const lotSize = getPositionLotSize(item, lotSizeMap);
                const openQty = Math.abs(getPositionQuantity(item));
                const existingStopLoss = getExistingStopLoss(item, stopLossBySymbol);
                const parsedLots = Math.max(1, Math.trunc(Number(draft?.lotsText || 0) || 0));
                const quantity = parsedLots * lotSize;
                const sideLabel = modifyMode === "exit"
                  ? (getPositionQuantity(item) > 0 ? "SELL" : "BUY")
                  : (getPositionQuantity(item) > 0 ? "BUY" : "SELL");
                const invalidExitQty = modifyMode === "exit" && quantity > openQty;

                return (
                  <View style={styles.legCard}>
                    <View style={styles.legHeader}>
                      <Text style={styles.legSymbol}>{item.symbol}</Text>
                      <View style={styles.legHeaderRight}>
                        {modifyMode === "sl" && existingStopLoss ? (
                          <Text style={styles.slTag}>
                            {`SL ${formatMoney(existingStopLoss.triggerPrice)}`}
                          </Text>
                        ) : null}
                        {instrument.expiry ? <Text style={styles.expiryTag}>{instrument.expiry}</Text> : null}
                        <Text style={styles.metaTag}>{draft?.product ?? "NRML"}</Text>
                      </View>
                    </View>

                    <View style={styles.controlRow}>
                      <View style={styles.controlBlock}>
                        <Text style={styles.fieldLabel}>Side</Text>
                        <View style={[styles.staticPill, sideLabel === "SELL" ? styles.staticPillDanger : styles.staticPillAccent]}>
                          <Text style={[styles.staticPillText, sideLabel === "SELL" ? styles.staticPillTextDanger : styles.staticPillTextAccent]}>
                            {sideLabel}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.controlBlock}>
                        <Text style={styles.fieldLabel}>Product</Text>
                        {modifyMode === "sl" ? (
                          <View style={[styles.staticPill, styles.staticPillMuted]}>
                            <Text style={[styles.staticPillText, styles.staticPillTextMuted]}>
                              {draft?.product ?? "NRML"}
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.segmentedRow}>
                            <CompactSegmentedButton
                              label="NRML"
                              active={(draft?.product ?? "NRML") === "NRML"}
                              onPress={() => updateDraft(item.symbol, { product: "NRML" })}
                            />
                            <CompactSegmentedButton
                              label="MIS"
                              active={(draft?.product ?? "NRML") === "MIS"}
                              onPress={() => updateDraft(item.symbol, { product: "MIS" })}
                            />
                          </View>
                        )}
                      </View>

                        <View style={styles.controlBlock}>
                        <Text style={styles.fieldLabel}>{modifyMode === "sl" ? "Order" : "Order"}</Text>
                        {modifyMode === "sl" ? (
                          <View style={[styles.staticPill, styles.staticPillAccent]}>
                            <Text style={[styles.staticPillText, styles.staticPillTextAccent]}>SL</Text>
                          </View>
                        ) : (
                          <View style={styles.segmentedRow}>
                            <CompactSegmentedButton
                              label="MKT"
                              active={(draft?.orderType ?? "MKT") === "MKT"}
                              onPress={() => updateDraft(item.symbol, { orderType: "MKT", priceText: "", triggerText: "" })}
                            />
                            <CompactSegmentedButton
                              label="L"
                              active={(draft?.orderType ?? "MKT") === "L"}
                              onPress={() => updateDraft(item.symbol, {
                                orderType: "L",
                                priceText: draft?.priceText || String(item.ltp ?? ""),
                                triggerText: "",
                              })}
                            />
                          </View>
                        )}
                      </View>
                    </View>

                    <View style={styles.doubleRow}>
                      <View style={styles.flexBlock}>
                        <Text style={styles.fieldLabel}>Lots</Text>
                        <TextInput
                          keyboardType="number-pad"
                          value={draft?.lotsText ?? "1"}
                          onChangeText={(value) => updateDraft(item.symbol, { lotsText: value })}
                          style={styles.input}
                          placeholder="1"
                          placeholderTextColor={palette.muted}
                        />
                      </View>
                      {modifyMode === "sl" ? (
                        <View style={styles.flexBlock}>
                          <Text style={styles.fieldLabel}>Trigger Price</Text>
                          <TextInput
                            keyboardType="decimal-pad"
                            value={draft?.triggerText ?? ""}
                            onChangeText={(value) => updateDraft(item.symbol, { triggerText: value })}
                            style={styles.input}
                            placeholder={String(item.ltp ?? 0)}
                            placeholderTextColor={palette.muted}
                          />
                        </View>
                      ) : (draft?.orderType ?? "MKT") === "L" ? (
                        <View style={styles.flexBlock}>
                          <Text style={styles.fieldLabel}>Limit Price</Text>
                          <TextInput
                            keyboardType="decimal-pad"
                            value={draft?.priceText ?? ""}
                            onChangeText={(value) => updateDraft(item.symbol, { priceText: value })}
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

                    {modifyMode === "sl" ? (
                      <View style={styles.singleRow}>
                        <Text style={styles.fieldLabel}>Limit Price</Text>
                        <TextInput
                          keyboardType="decimal-pad"
                          value={draft?.priceText ?? ""}
                          onChangeText={(value) => updateDraft(item.symbol, { priceText: value })}
                          style={styles.input}
                          placeholder={String(item.ltp ?? 0)}
                          placeholderTextColor={palette.muted}
                        />
                      </View>
                    ) : null}

                    <View style={styles.legFooter}>
                      <Text style={styles.legFooterText}>
                        Open {formatNumber(openQty, 0)} • Lot {formatNumber(lotSize, 0)}
                      </Text>
                      {modifyMode === "sl" ? (
                        <Text style={styles.legFooterValue}>
                          {`Trig ${formatMoney(Number(draft?.triggerText) || 0)} • Lim ${formatMoney(Number(draft?.priceText) || 0)}`}
                        </Text>
                      ) : (draft?.orderType ?? "MKT") === "L" ? (
                        <Text style={styles.legFooterValue}>
                          {formatMoney(quantity * (Number(draft?.priceText) || 0) * positionValueMultiplier(item, underlyingMap))}
                        </Text>
                      ) : (
                        <Text style={styles.legFooterText}>LTP {formatMoney(item.ltp ?? 0)}</Text>
                      )}
                    </View>

                    {modifyMode === "sl" && existingStopLoss && hasUsableOrderId(existingStopLoss.orderId) ? (
                      confirmCancelSymbol === item.symbol ? (
                        <View style={styles.cancelSlConfirmRow}>
                          <Text style={styles.cancelSlConfirmText}>Cancel this SL?</Text>
                          <View style={styles.cancelSlConfirmActions}>
                            <Pressable
                              onPress={() => setConfirmCancelSymbol(null)}
                              style={styles.cancelSlNoButton}
                            >
                              <Text style={styles.cancelSlNoButtonText}>No</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => void executeCancelStopLoss(existingStopLoss.orderId)}
                              disabled={actionSubmitting}
                              style={[styles.cancelSlYesButton, actionSubmitting && styles.selectionButtonDisabled]}
                            >
                              <Text style={styles.cancelSlYesButtonText}>Yes, Cancel</Text>
                            </Pressable>
                          </View>
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => setConfirmCancelSymbol(item.symbol)}
                          disabled={actionSubmitting}
                          style={[styles.cancelSlButton, actionSubmitting && styles.selectionButtonDisabled]}
                        >
                          <Text style={styles.cancelSlButtonText}>Cancel Existing SL</Text>
                        </Pressable>
                      )
                    ) : null}

                    {invalidExitQty ? (
                      <Text style={styles.cardError}>Exit quantity exceeds current open quantity.</Text>
                    ) : null}
                  </View>
                );
              }}
            />

            <View style={styles.modalFooter}>
              <Pressable
                onPress={() => {
                  if (!actionSubmitting) setModifyModalOpen(false);
                }}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Close</Text>
              </Pressable>
              <Pressable
                onPress={() => void submitModifySelection()}
                disabled={actionSubmitting}
                style={[styles.primaryButton, actionSubmitting && { opacity: 0.6 }]}
              >
                {actionSubmitting ? <ActivityIndicator color="#08111f" /> : (
                  <Text style={styles.primaryButtonText}>
                    Place {modifyMode === "sl" ? "SL" : modifyMode === "exit" ? "Exit" : "Add"} Orders
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Metric({ title, value, tone }: { title: string; value: string; tone?: number }) {
  return (
    <View style={styles.metricBlock}>
      <Text style={styles.metricTitle}>{title}</Text>
      <Text style={[
        styles.metricValue,
        typeof tone === "number" ? (tone >= 0 ? styles.positive : styles.negative) : null,
      ]}>
        {value}
      </Text>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.filterChip, active && styles.filterChipActive]}>
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SegmentedButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.segmentedButtonWide, active && styles.segmentedButtonWideActive]}>
      <Text style={[styles.segmentedButtonWideText, active && styles.segmentedButtonWideTextActive]}>{label}</Text>
    </Pressable>
  );
}

function CompactSegmentedButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.segmentedButton, active && styles.segmentedButtonActive]}>
      <Text style={[styles.segmentedButtonText, active && styles.segmentedButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function buildInitialModifyDrafts(
  positions: Position[],
  mode: ModifyMode,
  lotSizeMap?: Record<string, number>,
  stopLossBySymbol?: Map<string, OrderBookEntry[]>,
) {
  return Object.fromEntries(positions.map((position) => {
    const product = position.productType === "MIS" ? "MIS" : "NRML";
    const lotSize = getPositionLotSize(position, lotSizeMap);
    const openQty = Math.abs(getPositionQuantity(position));
    const existingStopLoss = mode === "sl" && stopLossBySymbol
      ? getExistingStopLoss(position, stopLossBySymbol)
      : null;
    const defaultLots = mode === "sl"
      ? Math.max(1, Math.trunc((existingStopLoss?.quantity ?? openQty) / lotSize) || 1)
      : Math.max(1, Math.min(Math.trunc(openQty / lotSize) || 1, 1));

    return [position.symbol, {
      product: (existingStopLoss?.productType === "MIS" ? "MIS" : product) as ProductType,
      orderType: (mode === "sl" ? "SL" : "MKT") as PositionOrderType,
      lotsText: String(defaultLots),
      priceText: existingStopLoss && mode === "sl"
        ? String(existingStopLoss.price > 0 ? existingStopLoss.price : existingStopLoss.triggerPrice || "")
        : "",
      triggerText: existingStopLoss && mode === "sl" ? String(existingStopLoss.triggerPrice || "") : "",
      existingStopLoss: existingStopLoss ? {
        orderId: existingStopLoss.orderId,
        tradingSymbol: existingStopLoss.tradingSymbol,
        exchangeSegment: existingStopLoss.exchangeSegment,
        instrumentToken: existingStopLoss.instrumentToken,
        quantity: existingStopLoss.quantity,
        triggerPrice: existingStopLoss.triggerPrice,
        price: existingStopLoss.price,
        productType: existingStopLoss.productType,
        validity: existingStopLoss.validity,
        disclosedQty: existingStopLoss.disclosedQty,
        side: existingStopLoss.side,
        orderType: existingStopLoss.orderType,
      } : null,
    }];
  }));
}

function validateModifySelection(
  positions: Position[],
  drafts: Record<string, ModifyDraft>,
  mode: ModifyMode,
  lotSizeMap?: Record<string, number>,
) {
  for (const position of positions) {
    const draft = drafts[position.symbol];
    const lotSize = getPositionLotSize(position, lotSizeMap);
    const openQty = Math.abs(getPositionQuantity(position));

    if (!draft || draft.lotsText.trim() === "") {
      return {
        title: "Missing lots",
        message: `Enter lots for ${position.symbol}.`,
      };
    }

    const parsedLots = Number(draft.lotsText);
    if (!Number.isFinite(parsedLots) || parsedLots <= 0) {
      return {
        title: "Invalid lots",
        message: `Lots must be a positive number for ${position.symbol}.`,
      };
    }

    if ((mode === "exit" || mode === "sl") && Math.max(1, Math.trunc(parsedLots)) * lotSize > openQty) {
      return {
        title: "Quantity too large",
        message: `${mode === "sl" ? "Stop-loss" : "Exit"} quantity cannot exceed current open quantity for ${position.symbol}.`,
      };
    }

    if (mode === "sl") {
      if (draft.triggerText.trim() === "") {
        return {
          title: "Missing trigger price",
          message: `Enter a trigger price for ${position.symbol}.`,
        };
      }

      const trigger = Number(draft.triggerText);
      if (!Number.isFinite(trigger) || trigger <= 0) {
        return {
          title: "Invalid trigger price",
          message: `Trigger price must be greater than zero for ${position.symbol}.`,
        };
      }

      if (draft.priceText.trim() === "") {
        return {
          title: "Missing limit price",
          message: `Enter a limit price for ${position.symbol}.`,
        };
      }

      const price = Number(draft.priceText);
      if (!Number.isFinite(price) || price <= 0) {
        return {
          title: "Invalid limit price",
          message: `Limit price must be greater than zero for ${position.symbol}.`,
        };
      }
    } else if (draft.orderType === "L") {
      if (draft.priceText.trim() === "") {
        return {
          title: "Missing limit price",
          message: `Enter a limit price for ${position.symbol}.`,
        };
      }

      const price = Number(draft.priceText);
      if (!Number.isFinite(price) || price <= 0) {
        return {
          title: "Invalid limit price",
          message: `Limit price must be greater than zero for ${position.symbol}.`,
        };
      }
    }
  }

  return null;
}

async function submitSquareOffSelection(
  positions: Position[],
  stopLossBySymbol: Map<string, OrderBookEntry[]>,
  lotSizeMap: Record<string, number> | undefined,
  refreshPositions: () => Promise<void>,
  clearSelection: () => void,
  setActionSubmitting: (value: boolean) => void,
  invalidateOrderBook: () => Promise<void>,
) {
  // Full exit must be a whole number of lots; never round a fractional
  // quantity into a partial (or oversized) square-off.
  const misaligned = positions.filter((position) => {
    const openQty = Math.abs(getPositionQuantity(position));
    return openQty % getPositionLotSize(position, lotSizeMap) !== 0;
  });
  if (misaligned.length) {
    Alert.alert(
      "Square off unavailable",
      `Open quantity is not a whole number of lots for: ${misaligned.map((position) => position.symbol).join(", ")}. Use Modify to exit these positions.`,
    );
    return;
  }

  const orders = positions.map((position) => buildPositionOrder({
    position,
    mode: "exit",
    draft: {
      product: position.productType === "MIS" ? "MIS" : "NRML",
      orderType: "MKT",
      lotsText: String(Math.max(1, Math.floor(Math.abs(getPositionQuantity(position)) / getPositionLotSize(position, lotSizeMap)))),
      priceText: "",
      triggerText: "",
      existingStopLoss: null,
    },
    lotSizeMap,
  }));

  if (orders.some((order) => !order)) {
    Alert.alert("Square off unavailable", "One or more selected positions are missing instrument details required to place an order.");
    return;
  }

  setActionSubmitting(true);
  try {
    const results = await placeOrders(orders as PlaceOrderLeg[]);
    const failures = results.filter((item) => !item.success);
    if (failures.length) {
      throw new Error(failures.map((item) => `Leg ${item.index + 1}: ${item.error}`).join("; "));
    }

    // full exit — target qty is 0 for every position
    const targetQtyBySymbol = new Map(positions.map((p) => [p.symbol, 0]));
    const [slResult] = await Promise.all([
      syncSlToPositionQty(positions, targetQtyBySymbol, stopLossBySymbol),
      refreshPositions(),
      invalidateOrderBook(),
    ]);

    clearSelection();
    const slNote = formatSlAdjustmentNote(slResult);
    Alert.alert(
      "Square off sent",
      `${formatNumber(results.length, 0)} position(s) squared off.${slNote}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    Alert.alert("Square off failed", message);
  } finally {
    setActionSubmitting(false);
  }
}

async function syncSlToPositionQty(
  positions: Position[],
  targetQtyBySymbol: Map<string, number>,
  stopLossBySymbol: Map<string, OrderBookEntry[]>,
): Promise<{ cancelled: number; modified: number; failed: number }> {
  type Outcome = "cancelled" | "modified" | "failed";

  // Build a lookup from any symbol key (tradingSymbol or symbol) → Position
  // so we can find the matching position when iterating SL orders.
  const positionByKey = new Map<string, Position>();
  for (const position of positions) {
    if (position.tradingSymbol) positionByKey.set(position.tradingSymbol, position);
    positionByKey.set(position.symbol, position);
  }

  const tasks: Promise<Outcome>[] = [];
  const processedOrderIds = new Set<string>();

  // Primary loop: iterate existing SL orders, find matching open position.
  for (const [symbolKey, slOrders] of stopLossBySymbol) {
    const position = positionByKey.get(symbolKey);
    if (!position) continue;

    const posQty = getPositionQuantity(position);
    const expectedSide = posQty > 0 ? "SELL" : "BUY";
    const targetQty = targetQtyBySymbol.get(position.symbol);
    if (targetQty === undefined) continue;

    for (const sl of slOrders) {
      if (!hasUsableOrderId(sl.orderId)) continue;
      if (processedOrderIds.has(sl.orderId)) continue;
      if (sl.side !== expectedSide) continue;
      processedOrderIds.add(sl.orderId);

      if (targetQty === 0) {
        // No remaining open position — cancel the SL order.
        tasks.push(
          cancelOrder(sl.orderId)
            .then((): Outcome => "cancelled")
            .catch((): Outcome => "failed"),
        );
      } else if (sl.quantity !== targetQty) {
        // SL quantity differs from target position size — sync qty, preserve prices.
        tasks.push(
          modifyOrder(sl.orderId, {
            quantity: targetQty,
            price: sl.price,
            trigger_price: sl.triggerPrice,
            disclosed_quantity: sl.disclosedQty ?? 0,
            validity: sl.validity || "DAY",
            order_type: sl.orderType,
            trading_symbol: sl.tradingSymbol || position.tradingSymbol || position.symbol,
            transaction_type: sl.side === "SELL" ? "S" : "B",
            exchange_segment: sl.exchangeSegment || undefined,
            product: sl.productType || "NRML",
            instrument_token: sl.instrumentToken || "",
          })
            .then((): Outcome => "modified")
            .catch((): Outcome => "failed"),
        );
      }
      // sl.quantity === targetQty: already in sync, no action needed.
    }
  }

  const outcomes = await Promise.all(tasks);
  return {
    cancelled: outcomes.filter((o) => o === "cancelled").length,
    modified: outcomes.filter((o) => o === "modified").length,
    failed: outcomes.filter((o) => o === "failed").length,
  };
}

function formatSlAdjustmentNote(result: { cancelled: number; modified: number; failed: number }) {
  const parts: string[] = [];
  if (result.cancelled) parts.push(`${result.cancelled} SL(s) cancelled`);
  if (result.modified) parts.push(`${result.modified} SL(s) adjusted`);
  if (!parts.length) return "";
  const note = ` ${parts.join(", ")}.`;
  return result.failed ? `${note} ${result.failed} SL adjustment(s) failed.` : note;
}

function buildPositionOrder({
  position,
  mode,
  draft,
  lotSizeMap,
}: {
  position: Position;
  mode: ModifyMode;
  draft: ModifyDraft;
  lotSizeMap?: Record<string, number>;
}): PlaceOrderLeg | null {
  const instrument = describePositionInstrument(position);
  const strike = Number((position.strikePrice ?? instrument.strike).replace(/,/g, ""));
  const optionType = normalizeOptionType(position.optionType ?? instrument.optionType);
  const underlying = instrument.underlying;
  const expiry = normalizeExpiryForOrder(position.expiry ?? "");

  if (!underlying || !expiry || !Number.isFinite(strike) || !optionType) {
    return null;
  }

  const lotSize = getPositionLotSize(position, lotSizeMap);
  const lots = Math.max(1, Math.trunc(Number(draft.lotsText) || 0));
  const quantity = lots * lotSize;
  const netQty = getPositionQuantity(position);
  const transactionType = mode === "exit" || mode === "sl"
    ? (netQty > 0 ? "S" : "B")
    : (netQty > 0 ? "B" : "S");

  return {
    underlying,
    expiry,
    strike,
    optionType,
    transactionType,
    quantity,
    orderType: mode === "sl" ? "SL" : draft.orderType,
    product: draft.product,
    price: mode === "sl" ? Number(draft.priceText) || 0 : draft.orderType === "L" ? Number(draft.priceText) || 0 : 0,
    triggerPrice: mode === "sl" ? Number(draft.triggerText) || 0 : 0,
    disclosedQuantity: 0,
  };
}

function getPositionLotSize(position: Position, lotSizeMap?: Record<string, number>) {
  const underlying = describePositionInstrument(position).underlying;
  return Math.max(position.lotSize ?? lotSizeMap?.[underlying] ?? 1, 1);
}

function getExistingStopLoss(position: Position, stopLossBySymbol: Map<string, OrderBookEntry[]>) {
  const netQty = getPositionQuantity(position);
  if (!netQty) return null;
  const expectedSide = netQty > 0 ? "SELL" : "BUY";

  const tradingSymbol = position.tradingSymbol;
  if (tradingSymbol && stopLossBySymbol.has(tradingSymbol)) {
    const match = stopLossBySymbol.get(tradingSymbol)?.find((order) => order.side === expectedSide);
    if (match) return match;
  }

  if (stopLossBySymbol.has(position.symbol)) {
    const match = stopLossBySymbol.get(position.symbol)?.find((order) => order.side === expectedSide);
    if (match) return match;
  }

  return null;
}

function getPositionStopLossTrigger(
  position: Position,
  stopLossBySymbol: Map<string, OrderBookEntry[]>,
) {
  return getExistingStopLoss(position, stopLossBySymbol)?.triggerPrice ?? null;
}

function isExistingStopLossUnchanged(
  existingStopLoss: ExistingStopLossDraft,
  next: {
    quantity: number;
    triggerPrice: number;
    limitPrice: number;
    product: ProductType;
    transactionType: "B" | "S";
  },
) {
  return (
    existingStopLoss.quantity === next.quantity
    && existingStopLoss.side === (next.transactionType === "B" ? "BUY" : "SELL")
    && existingStopLoss.productType === next.product
    && Math.abs(existingStopLoss.triggerPrice - next.triggerPrice) < 0.001
    && Math.abs(existingStopLoss.price - next.limitPrice) < 0.001
    && existingStopLoss.orderType === "SL"
  );
}

/** Segment-level realized P&L: live rows carry realizedPnlComponent; paper rows book on close. */
function sumRealizedPnl(positions: Position[]) {
  const total = positions.reduce((sum, position) => {
    if (typeof position.realizedPnlComponent === "number") return sum + position.realizedPnlComponent;
    return getPositionIsOpen(position) ? sum : sum + (position.bookedPnl ?? 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

function hasUsableOrderId(orderId?: string | null) {
  if (!orderId) return false;
  const normalized = orderId.trim().toLowerCase();
  return normalized !== "" && normalized !== "undefined" && normalized !== "null";
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  pnlCard: {
    backgroundColor: "#10161c",
    marginBottom: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  pnlHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  pnlHeaderLabel: {
    color: "#8e99a8",
    fontSize: 12,
    fontWeight: "700",
  },
  pnlHeaderValue: {
    fontSize: 17,
    fontWeight: "800",
  },
  pnlBreakdown: {
    flexDirection: "row",
    gap: 12,
  },
  metricBlock: {
    flex: 1,
  },
  metricTitle: {
    color: palette.muted,
    fontSize: 10,
    marginBottom: 7,
  },
  metricValue: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "800",
  },
  actionRow: {
    marginBottom: 12,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "#354150",
    borderRadius: 18,
    backgroundColor: "#11161d",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  searchInput: {
    flex: 1,
    color: palette.text,
    fontSize: 12,
    paddingVertical: 0,
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#334151",
    backgroundColor: "#11161d",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterChipActive: {
    borderColor: "#18a9ff",
    backgroundColor: "#0d2230",
  },
  filterChipText: {
    color: "#9dacbf",
    fontSize: 11,
    fontWeight: "700",
  },
  filterChipTextActive: {
    color: "#18a9ff",
  },
  selectionBar: {
    backgroundColor: "#0e1822",
    borderWidth: 1,
    borderColor: "#213448",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  selectionCount: {
    color: palette.text,
    fontSize: 14,
    fontWeight: "800",
  },
  selectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  selectionButton: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexShrink: 1,
    minWidth: 0,
  },
  selectionButtonAmber: {
    borderColor: "#aa7e26",
    backgroundColor: "#231a0b",
  },
  selectionButtonInfo: {
    borderColor: "#2f93d6",
    backgroundColor: "#12283a",
  },
  selectionButtonDanger: {
    borderColor: "#9c3737",
    backgroundColor: "#261012",
  },
  selectionButtonDisabled: {
    opacity: 0.45,
  },
  selectionButtonText: {
    fontSize: 10,
    fontWeight: "700",
    flexShrink: 1,
  },
  selectionButtonTextAmber: {
    color: "#ffc768",
  },
  selectionButtonTextInfo: {
    color: "#4ec7ff",
  },
  selectionButtonTextDanger: {
    color: "#ff8787",
  },
  positive: {
    color: "#32d19a",
  },
  negative: {
    color: "#ff6666",
  },
  listContent: {
    paddingTop: 10,
    paddingHorizontal: 0,
    paddingBottom: 0,
  },
  listHeader: {
    paddingHorizontal: 10,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(3, 9, 14, 0.72)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#0d1722",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: "#203246",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 28,
    maxHeight: "88%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  modalHeaderMain: {
    flex: 1,
    paddingRight: 10,
  },
  modalTitle: {
    color: palette.text,
    fontSize: 18,
    fontWeight: "800",
  },
  modalSubtitle: {
    color: palette.muted,
    fontSize: 11,
    marginTop: 4,
  },
  modalCloseButton: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: palette.border,
    alignItems: "center",
    justifyContent: "center",
  },
  modalSection: {
    marginBottom: 12,
  },
  modalLabel: {
    color: "#8ea3b8",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  modalSegmented: {
    flexDirection: "row",
    gap: 8,
  },
  segmentedButtonWide: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2a3a4b",
    backgroundColor: "#101925",
    paddingVertical: 10,
    alignItems: "center",
  },
  segmentedButtonWideActive: {
    borderColor: "#2f93d6",
    backgroundColor: "#12283a",
  },
  segmentedButtonWideText: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  segmentedButtonWideTextActive: {
    color: "#4ec7ff",
  },
  modifyList: {
    flexGrow: 0,
  },
  modifyListContent: {
    paddingBottom: 12,
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
  legHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  legSymbol: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "700",
    flex: 1,
    paddingRight: 10,
  },
  legHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
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
  slTag: {
    color: "#7cc4ff",
    backgroundColor: "#10263d",
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
  controlRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 10,
  },
  controlBlock: {
    flex: 1,
  },
  fieldLabel: {
    ...textStyles.label,
    marginBottom: 5,
    fontSize: 9,
    letterSpacing: 0.35,
  },
  staticPill: {
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
  },
  staticPillAccent: {
    borderColor: "#2f93d6",
    backgroundColor: "#132739",
  },
  staticPillDanger: {
    borderColor: "#d25454",
    backgroundColor: "#2a1618",
  },
  staticPillMuted: {
    borderColor: "#2a3a4b",
    backgroundColor: "#101925",
  },
  staticPillText: {
    fontSize: 10,
    fontWeight: "700",
  },
  staticPillTextAccent: {
    color: "#4ec7ff",
  },
  staticPillTextDanger: {
    color: "#ff7d7d",
  },
  staticPillTextMuted: {
    color: palette.text,
  },
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
  segmentedButtonText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700",
  },
  segmentedButtonTextActive: {
    color: "#4ec7ff",
  },
  doubleRow: {
    flexDirection: "row",
    gap: 10,
  },
  flexBlock: {
    flex: 1,
  },
  singleRow: {
    marginTop: -2,
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
  legFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  legFooterText: {
    color: palette.muted,
    fontSize: 10,
  },
  legFooterValue: {
    color: palette.text,
    fontSize: 12,
    fontWeight: "800",
  },
  cancelSlButton: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#9c3737",
    backgroundColor: "#261012",
    paddingVertical: 8,
    alignItems: "center",
  },
  cancelSlButtonText: {
    color: "#ff8787",
    fontSize: 10,
    fontWeight: "700",
  },
  cancelSlConfirmRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cancelSlConfirmText: {
    color: "#ff8787",
    fontSize: 10,
    fontWeight: "700",
    flex: 1,
  },
  cancelSlConfirmActions: {
    flexDirection: "row",
    gap: 6,
  },
  cancelSlNoButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a3a4b",
    backgroundColor: "#101925",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cancelSlNoButtonText: {
    color: palette.muted,
    fontSize: 10,
    fontWeight: "700",
  },
  cancelSlYesButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#9c3737",
    backgroundColor: "#261012",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  cancelSlYesButtonText: {
    color: "#ff8787",
    fontSize: 10,
    fontWeight: "700",
  },
  cardError: {
    color: "#ff7d7d",
    fontSize: 10,
    marginTop: 6,
  },
  modalFooter: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2a3a4b",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#101925",
  },
  secondaryButtonText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: "700",
  },
  primaryButton: {
    flex: 1.5,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#47d29d",
  },
  primaryButtonText: {
    color: "#08111f",
    fontSize: 13,
    fontWeight: "800",
  },
});

import { toast } from "sonner";
import type { PlaceOrderResult } from "@/lib/api-client.real";
import type { OrderLifecycleEvent } from "@/types/orders";

/**
 * Dedup window: suppress duplicate toasts when REST response and WS event
 * arrive within 5 seconds for the same order number.
 */
const _recentlyToasted = new Map<string, number>();
const _DEDUP_WINDOW_MS = 5_000;

function shouldSuppress(orderNumber: string): boolean {
  if (!orderNumber) return false;
  const now = Date.now();
  // Prune expired entries
  for (const [key, ts] of _recentlyToasted) {
    if (now - ts > _DEDUP_WINDOW_MS) _recentlyToasted.delete(key);
  }
  if (_recentlyToasted.has(orderNumber)) return true;
  _recentlyToasted.set(orderNumber, now);
  return false;
}

/**
 * Show toast notifications for order placement results.
 * - All success → single success toast
 * - Partial failures → success + error toasts
 * - All failed → single error toast
 */
export function toastOrderResults(
  results: PlaceOrderResult[],
  action: string = "Order",
) {
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  if (successes.length > 0) {
    const symbols = successes
      .map((r) => r.tradingSymbol ?? `#${r.orderNumber}`)
      .join(", ");
    toast.success(
      successes.length === 1
        ? `${action} placed`
        : `${successes.length} orders placed`,
      { description: symbols },
    );
    // Register in dedup map so the WS lifecycle echo is suppressed
    for (const r of successes) {
      if (r.orderNumber) _recentlyToasted.set(r.orderNumber, Date.now());
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      toast.error(`${action} rejected`, {
        description: f.error ?? `Leg ${f.index + 1} failed`,
      });
    }
  }
}

/** Toast for a successful cancel/modify action. */
export function toastOrderAction(
  action: "Cancelled" | "Modified",
  orderId: string,
) {
  toast.success(`Order ${action.toLowerCase()}`, {
    description: `Order ${orderId}`,
  });
  // Register in dedup map so the WS lifecycle echo is suppressed
  if (orderId) _recentlyToasted.set(orderId, Date.now());
}

/** Toast for a failed action. */
export function toastOrderError(action: string, error: unknown) {
  toast.error(`${action} failed`, {
    description: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Show a toast for a real-time order lifecycle event from the broker WebSocket.
 * Called by DataFeedOrchestrator when an `orders:events:` message arrives.
 */
export function toastOrderLifecycleEvent(event: OrderLifecycleEvent): void {
  if (shouldSuppress(event.orderNumber)) return;

  const { status, side, symbol, filledQty, totalQty, avgPrice, rejectionReason } = event;

  switch (status) {
    case "FILLED": {
      toast.success("Order filled", {
        description: `${side} ${totalQty} ${symbol} @ ${avgPrice.toFixed(2)}`,
      });
      break;
    }
    case "PARTIAL_FILL": {
      toast.info("Partial fill", {
        description: `${side} ${filledQty}/${totalQty} ${symbol} @ ${avgPrice.toFixed(2)}`,
      });
      break;
    }
    case "REJECTED": {
      toast.error("Order rejected", {
        description: `${side} ${totalQty} ${symbol} — ${rejectionReason || "Unknown reason"}`,
      });
      break;
    }
    case "CANCELLED": {
      toast.warning("Order cancelled", {
        description: `${side} ${totalQty} ${symbol}`,
      });
      break;
    }
  }
}

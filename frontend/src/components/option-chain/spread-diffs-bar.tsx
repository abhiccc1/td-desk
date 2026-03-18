import type { StrategyLeg, GreeksResult, OptionType } from "@/types/market-data";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpreadPairDiffs {
  optionType: OptionType;
  strikeWidth: number;
  deltaDiff: number | null;
  ivDiff: number | null;
}

export interface SpreadDiffsData {
  pairs: SpreadPairDiffs[];
  netPositionDelta: number | null;
}

// ─── Computation ─────────────────────────────────────────────────────────────

export function computeSpreadDiffs(
  legs: StrategyLeg[],
  greeksMap: Map<string, GreeksResult>,
): SpreadDiffsData | null {
  if (legs.length < 2) return null;

  const pairs: SpreadPairDiffs[] = [];

  for (const ot of ["CE", "PE"] as OptionType[]) {
    const group = legs.filter((l) => l.optionType === ot);
    const buys = group.filter((l) => l.side === "BUY");
    const sells = group.filter((l) => l.side === "SELL");
    if (buys.length !== 1 || sells.length !== 1) continue;

    const buy = buys[0];
    const sell = sells[0];
    const buyG = greeksMap.get(buy.symbol);
    const sellG = greeksMap.get(sell.symbol);

    // Signed width: CE → sell - buy (higher sell = positive),
    //               PE → buy - sell (higher buy = positive)
    const strikeWidth =
      ot === "CE" ? sell.strike - buy.strike : buy.strike - sell.strike;

    pairs.push({
      optionType: ot,
      strikeWidth,
      deltaDiff: sellG && buyG ? sellG.delta - buyG.delta : null,
      ivDiff: sellG && buyG ? sellG.iv - buyG.iv : null,
    });
  }

  // Net position delta: sum(delta * qty * sideSign) across all legs
  let netPositionDelta: number | null = 0;
  for (const leg of legs) {
    const g = greeksMap.get(leg.symbol);
    if (!g) {
      netPositionDelta = null;
      break;
    }
    const sign = leg.side === "BUY" ? 1 : -1;
    netPositionDelta! += g.delta * leg.quantity * sign;
  }

  if (pairs.length === 0 && netPositionDelta == null) return null;
  if (pairs.length === 0 && netPositionDelta === 0) return null;

  return { pairs, netPositionDelta };
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtSignedDelta(v: number | null): string {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(3)}`;
}

function fmtIvPp(v: number | null): string {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}pp`;
}

function fmtNetDelta(v: number | null): string {
  if (v == null) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface SpreadDiffsBarProps {
  data: SpreadDiffsData;
}

export function SpreadDiffsBar({ data }: SpreadDiffsBarProps) {
  const { pairs, netPositionDelta } = data;

  return (
    <div className="flex shrink-0 border-t border-panel-border bg-panel-hover px-3 py-1.5 text-xs">
      <div className="flex flex-col gap-0.5">
        {pairs.map((p) => {
          const color = p.optionType === "CE" ? "text-green-400" : "text-red-400";
          return (
            <div key={p.optionType} className={color}>
              <span className="font-medium">{p.optionType}</span>
              {" Strike: "}
              {p.strikeWidth >= 0 ? "+" : ""}{p.strikeWidth}
              {" - Delta: "}
              {fmtSignedDelta(p.deltaDiff)}
              {" - IV: "}
              {fmtIvPp(p.ivDiff)}
            </div>
          );
        })}
      </div>

      {netPositionDelta != null && (
        <span className="ml-auto self-center whitespace-nowrap">
          <span className="text-panel-subtle">Net Delta: </span>
          <span
            className={
              netPositionDelta >= 0 ? "text-green-400" : "text-red-400"
            }
          >
            {fmtNetDelta(netPositionDelta)}
          </span>
        </span>
      )}
    </div>
  );
}

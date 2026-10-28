import { formatNumber } from "@/lib/format";
import type { Position } from "@/types/api";

export function getPositionQuantity(position: Position) {
  return position.netQty ?? position.quantity ?? 0;
}

export function getPositionIsOpen(position: Position) {
  return position.isOpen !== false && getPositionQuantity(position) !== 0;
}

export function describePositionInstrument(position: Position) {
  const trading = position.tradingSymbol ?? position.symbol;
  const underlying = extractUnderlying(trading);
  const strike = position.strikePrice ? formatStrike(Number(position.strikePrice)) : extractStrike(trading);
  const optionType = normalizeOptionType(position.optionType ?? trading);
  const expiry = formatExpiryChip(position.expiry ?? trading);

  return {
    underlying,
    strike,
    optionType,
    expiry,
  };
}

export function extractUnderlying(value: string) {
  const match = value.match(/^([A-Z]+)/);
  return match?.[1] ?? value;
}

export function extractStrike(value: string) {
  // Prefer the number right before CE/PE so a 6-digit YYMMDD expiry
  // ("NIFTY 260317 23800 CE") is never mistaken for the strike.
  const beforeType = value.match(/\s(\d{2,6}(?:\.\d+)?)\s+(?:CE|PE)\b/);
  if (beforeType) return beforeType[1];
  const match = value.match(/\s(\d{2,6}(?:\.\d+)?)(?:\s|$)/);
  return match?.[1] ?? "";
}

/** Integer strikes render without decimals; fractional MCX strikes keep theirs. */
export function formatStrike(value: number) {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? formatNumber(value, 0) : formatNumber(value, 2);
}

export function normalizeOptionType(value: string) {
  if (/\bCE\b|CALL/i.test(value)) return "CE";
  if (/\bPE\b|PUT/i.test(value)) return "PE";
  return "";
}

export function formatExpiryChip(value: string) {
  if (!value) return "";

  const cleaned = value.replace(/,\s*/g, " ").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      }).toUpperCase();
    }
  }

  const compact = value.match(/\b(\d{6})\b/);
  if (compact) {
    const raw = compact[1];
    return `${raw.slice(4, 6)} ${monthFromNumber(raw.slice(2, 4))}`.toUpperCase();
  }

  const brokerLike = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,})/);
  if (brokerLike) {
    const day = brokerLike[1].padStart(2, "0");
    const month = brokerLike[2].slice(0, 3).toUpperCase();
    return `${day} ${month}`;
  }

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
    }).toUpperCase();
  }

  return "";
}

export function normalizeExpiryForOrder(value: string) {
  if (!value) return "";

  const cleaned = value.replace(/,\s*/g, " ").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  const compact = cleaned.match(/\b(\d{6})\b/);
  if (compact) {
    const raw = compact[1];
    return `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
  }

  const brokerLike = cleaned.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (brokerLike) {
    const day = brokerLike[1].padStart(2, "0");
    const month = monthNumberFromName(brokerLike[2]);
    const year = brokerLike[3];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }

  return "";
}

function monthFromNumber(month: string) {
  const names = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const index = Number(month) - 1;
  return names[index] ?? month;
}

function monthNumberFromName(month: string) {
  const lookup: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return lookup[month.slice(0, 3).toLowerCase()] ?? "";
}

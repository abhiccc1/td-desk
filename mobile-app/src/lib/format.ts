export function formatMoney(value: number | null | undefined) {
  const safe = Number.isFinite(value) ? Number(value) : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(safe);
}

export function formatNumber(value: number | null | undefined, decimals = 2) {
  const safe = Number.isFinite(value) ? Number(value) : 0;
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(safe);
}

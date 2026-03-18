# Mock Data Module

> Deterministic mock data generators, fake API client, and live ticker
> for offline frontend development without backend services.

Legend: `[x]` done | `[~]` stub/partial | `[ ]` not started

---

## Seed & Math

- [x] `constants.ts` — ATM price, strike step, lot size, expiries, intervals
- [x] `black-scholes.ts` — normalCdf/Pdf, bsPrice, bsDelta/Gamma/Theta/Vega, IV smile

## Generators

- [x] `option-chain.ts` — 25-strike chain with IV smile, OI bell curve, bid-ask
- [x] `greeks.ts` — GreeksResult[] from BS functions
- [x] `quotes.ts` — TickData for underlying or parsed option symbol
- [x] `ohlcv.ts` — Deterministic random-walk OHLCV candles
- [x] `positions.ts` — Sample short strangle (22300PE + 22700CE SELL)
- [x] `strategy.ts` — Payoff curve, breakevens, margin computation

## Mock Services

- [x] `api-client.mock.ts` — All 9 API functions with simulated 50-200ms delays
- [x] `mock-ws-ticker.ts` — setInterval perturbing chain prices → store hydration
- [x] `index.ts` — initMocks() / teardownMocks() bootstrap

## Integration

- [x] `api-client.real.ts` — Original api-client contents moved here
- [x] `api-client.ts` — Dynamic import ternary on NEXT_PUBLIC_MOCK_MODE
- [x] `ws-client.ts` — Early return in connect() when mock mode
- [x] `page.tsx` — useEffect dynamic import of initMocks() when mock mode
- [x] `.env.local.example` — NEXT_PUBLIC_MOCK_MODE=false added

---

**Total: 15 done | 0 partial | 0 remaining**

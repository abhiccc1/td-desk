# Strategy Analytics Guide — Reading the Payoff Diagram

This guide explains every metric and visual element in the td-desk Payoff Diagram
panel, and how to use them together to evaluate trade risk/reward before placing
an order.

---

## The Payoff Curve (Green / Red Line)

The foundation. Shows your strategy's profit or loss at expiry for every possible
underlying price.

- **Green** = profit (P&L > 0)
- **Red** = loss (P&L < 0)
- **White dashed line** = zero line (breakeven boundary)
- **White dots** = breakeven prices

**How to use it:**

Look at the shape first. A good risk/reward trade has a wide green zone relative
to the red zones, and the max loss is bounded. For an iron condor, the green
plateau should be wide enough to cover likely spot movement.

Key questions:
- Is max profit realistic relative to max loss? (Risk/reward ratio)
- Are the breakevens far enough from current spot to survive normal movement?
- Is the payoff symmetric or does one side have more risk?

---

## Density Overlay (Blue Shaded Area)

The risk-neutral probability density function (PDF) of where the underlying
price will be at expiry, derived from the Heston stochastic volatility model
via inverse FFT of the characteristic function.

- **Peak** = most probable expiry price (near the forward price)
- **Width** = how much uncertainty the model sees
- **Tails** = probability of extreme moves
- **Right axis** = density scale (probability per unit price)

**How to use it:**

Overlay the density on the payoff curve mentally. The regions where the density
is high AND the payoff is green are where your strategy makes money with high
probability. Regions where density is high AND payoff is red are danger zones.

For an iron condor:
- If the density peak sits inside the green plateau → good: most probable
  outcomes are profitable
- If the density tails extend significantly into the red wings → caution:
  the model assigns meaningful probability to loss scenarios
- A narrow, tall density (low vol regime) favors short premium strategies
- A wide, flat density (high vol regime) favors long premium strategies

For a vertical spread:
- Check how much of the density falls above/below your breakeven
- If the density is skewed toward your profitable side → favorable setup

---

## PoP (Probability of Profit) — Three Variants

### PoP (unif)

The naive probability: what fraction of the payoff grid points are positive.
Treats all prices as equally likely. This is almost always misleading for
options because extreme prices (20% away from spot) are not equally likely
as near-ATM prices.

**Use it as:** A baseline sanity check only. If PoP (unif) is high but the
Heston PoP is low, your profit zone is wide but the density is concentrated
in a loss region — unusual but possible for directional trades.

### PoP (Heston)

The risk-neutral probability of profit using the calibrated Heston stochastic
volatility model. This integrates the Heston density over the profitable region
of your payoff curve:

```
PoP = ∫ f_heston(S) · 1_{payoff(S) > 0} dS
```

This accounts for:
- Mean-reversion of variance (kappa, theta)
- Vol-of-vol / fat tails (sigma_v)
- Spot-vol correlation / skew (rho)

**Use it as:** Your primary probability estimate. When calibrated, this is the
most realistic single-number summary of your strategy's chance of success.

### PoP (VG)

Same integration but using the Variance Gamma model, which captures jump risk
(sudden large moves) via a subordinated Brownian motion.

**Use it as:** A cross-check against Heston. Large divergence between the two
(e.g., Heston 70% vs VG 85%) means the models disagree on tail behavior —
a signal that your strategy's outcome is sensitive to which distributional
assumption you believe.

**Rules of thumb:**
- Both models agree (within ~5%) → higher confidence in the estimate
- VG >> Heston → VG's thinner tails favor your strategy; Heston's fatter tails
  penalize it. If you believe in stochastic vol over jump-diffusion, trust Heston.
- VG << Heston → rare; suggests the jump component hurts your strategy more than
  stochastic vol does.

---

## Edge (Model PoP − Market PoP)

The key trading signal. Compares the Heston model's PoP against what a simple
BSM lognormal density (using the market's ATM implied volatility from the SVI
surface) would predict.

```
Edge = PoP(Heston) − PoP(BSM with SVI ATM IV)
```

**Interpretation:**

| Edge       | Color  | Meaning |
|------------|--------|---------|
| > 0        | Green  | Heston sees MORE profit probability than BSM. The market (BSM) underestimates your strategy's chance of success. |
| 0 to −2%  | Yellow | Neutral — models roughly agree. |
| < −2%     | Red    | Heston sees LESS profit probability than BSM. The market (BSM) overestimates your strategy's safety. |

**How to use it:**

For **short premium** strategies (iron condors, strangles, credit spreads):
- **Negative edge is a warning.** BSM thinks the strategy is safer than Heston
  does. Heston's fat tails assign more probability to large moves that breach
  your breakevens. The market's ATM IV doesn't fully price in tail risk.
- A large negative edge (< −15%) suggests the strategy is being entered in a
  regime where stochastic vol dynamics make it riskier than it appears from IV alone.
- This doesn't mean "don't trade" — it means size conservatively and set wider wings.

For **long premium** strategies (long straddles, debit spreads):
- **Positive edge is favorable.** Heston's fat tails increase the probability
  of the large move you need.
- **Negative edge means even the fat-tail model thinks you're unlikely to profit.**

**Example from the screenshot:**
Edge = −25.3% means BSM (with SVI ATM IV ~15%) gives ~95% PoP for the iron
condor, but Heston gives ~70%. The 25% gap is entirely due to Heston's fat
tails. In a 4-day expiry, BSM says "spot won't move much," but Heston says
"stochastic vol means there's a 30% chance it moves enough to breach your wings."

---

## VaR (5%) — Value at Risk

The 5th percentile of your strategy's P&L distribution under the Heston model.
In plain terms: **in the worst 5% of scenarios, your P&L will be at or below
this value.**

- Shown as an **orange dashed horizontal line** (P&L level) and **orange dashed
  vertical line** (the spot price that produces this P&L)
- Denominated in ₹ (total strategy P&L, not per-lot)

**How to use it:**

VaR answers: "What's the worst I should plan for, excluding extreme black swans?"

- Compare VaR to your **max affordable loss**. If VaR exceeds your risk budget,
  reduce position size or widen the wings.
- Compare VaR to **max loss**. If VaR ≈ max loss, the model thinks there's a
  >5% chance of hitting max loss — the strategy is aggressive.
- If VaR is much smaller than max loss, the probability of extreme outcomes
  is low — you have a margin of safety.

**For the example:** VaR(5%) = ₹−7.7L vs max put-side loss = ₹−9.3L. The model
says there's about a 5% chance of losing ₹7.7L or more. Since max loss is only
₹1.6L worse, the tail is concentrated — if things go wrong, they go very wrong.
This is typical for short premium strategies.

---

## ES (5%) — Expected Shortfall (Conditional VaR)

The average loss **given that you're in the worst 5% of scenarios**. Always
worse than or equal to VaR.

```
ES = E[P&L | P&L ≤ VaR]
```

**How to use it:**

ES answers: "When things go bad, how bad on average?"

- **ES ≈ VaR** → losses are clustered near VaR; the tail is thin. Less scary.
- **ES >> VaR** → losses in the tail are much worse than VaR alone suggests.
  The left tail is fat. Be cautious.
- Use ES for position sizing: size so that your ES doesn't exceed X% of
  your account.

**For the example:** ES(5%) = ₹−9.1L vs VaR(5%) = ₹−7.7L. The gap is ₹1.4L,
meaning conditional on being in the worst 5%, the average outcome is near max
loss. This confirms: if this iron condor breaches, it goes close to max loss.

---

## Risk/Reward Ratio — The Core Filter

Before looking at any model output, compute the raw risk/reward from the payoff
curve. This is the most important number.

```
Risk/Reward = Max Profit / |Max Loss|
```

For credit strategies (iron condors, credit spreads, strangles), you receive
premium upfront and risk a larger loss. For debit strategies (long calls/puts,
debit spreads), you pay upfront and target a larger gain.

### Reading Risk/Reward from the Payoff Diagram

| Value | From the chart | Meaning |
|-------|----------------|---------|
| Max Profit | Height of the green plateau above zero | Best-case scenario |
| Max Loss | Depth of the red region below zero | Worst-case scenario |
| Breakeven Width | Distance between breakeven dots | How far spot can move before you lose |
| Risk/Reward | Green height ÷ red depth | Premium received per unit of risk |

### Risk/Reward by Strategy Type

| Strategy | Typical R:R | What "good" looks like |
|----------|-------------|----------------------|
| Iron Condor | 0.3–0.5 | Accept low R:R because PoP is high (65%+) |
| Credit Spread | 0.3–0.7 | Similar to condor; one directional leg |
| Debit Spread | 1.5–3.0 | Need higher R:R because PoP is lower |
| Long Straddle | 2.0–5.0+ | Need large R:R — you're paying premium into theta decay |
| Naked Strangle | 0.1–0.3 | Worst R:R but highest PoP; one bad move wipes many winners |

### Combining Risk/Reward with Model Metrics

Raw R:R alone is misleading. A 0.3 R:R iron condor with 70% PoP (Heston) is
better than a 2.0 R:R debit spread with 25% PoP. The right way to combine them:

**Expected Value (EV):**
```
EV = (PoP × Max Profit) − ((1 − PoP) × |Max Loss|)
```

Use the Heston PoP (not uniform) for this calculation.

| Scenario | EV interpretation |
|----------|-------------------|
| EV > 0 | Strategy has positive expectancy — on average, you profit |
| EV ≈ 0 | Break-even trade — no systematic edge |
| EV < 0 | Negative expectancy — the market is pricing this correctly or against you |

**Example from the screenshot:**
- Max Profit = ₹1,24,069 (net credit × qty)
- Max Loss (put side) = ₹−9,32,181
- PoP (Heston) = 69.9%
- EV = (0.699 × 1,24,069) − (0.301 × 9,32,181) = ₹86,724 − ₹2,80,587 = **₹−1,93,863**

Despite 70% PoP, the EV is deeply negative because the max loss is ~7.5× the max
profit. This is the classic iron condor trap: high PoP masks poor risk/reward.

**How to improve it:**
- Narrow the wings → lower max loss → better R:R (but less premium)
- Use symmetric spreads → equalize risk on both sides
- Check the Edge: if Edge is positive, the model sees even better odds than the
  market, improving effective EV
- Size so that max loss is survivable: never risk more than 2-5% of account on
  a single condor

### The Kelly-Informed Sizing Rule

Once you have PoP and R:R, the Kelly Criterion gives optimal position size:

```
Kelly fraction = (PoP × (1 + R:R) − 1) / R:R
```

Where R:R = Max Profit / |Max Loss|.

- **Kelly > 0**: the trade has positive edge; size up to Kelly% of account
- **Kelly = 0**: break-even; no sizing justification
- **Kelly < 0**: negative edge; don't take the trade

### Risk/Reward Red Flags

- **R:R < 0.2 with uncalibrated models**: you're relying on PoP being correct,
  but the model isn't calibrated. One tail event wipes 5+ winners.
- **Asymmetric wings**: one side has 2-3× the max loss of the other. Size for the
  worse side, not the average.
- **VaR ≈ Max Loss**: the model says there's a >5% chance of hitting max loss.
  Combined with R:R < 0.5, this is a high-risk profile.
- **Negative EV with positive PoP**: the strategy wins often but loses big. Classic
  "picking up pennies in front of a steamroller."

---

## Putting It All Together — Trade Evaluation Checklist

### Step 1: Read the Payoff Shape and Risk/Reward
- Is risk bounded? (Iron condor: yes. Naked strangle: no.)
- Compute R:R = Max Profit / |Max Loss|. Below 0.2 → needs very high PoP to justify.
- Where are the breakevens relative to spot?
- Are the wings symmetric? If not, size for the worse side.

### Step 2: Check the Density Overlay
- Does the density peak sit inside the profit zone?
- How much density bleeds into the loss wings?
- Is the density narrow (low vol, favors sellers) or wide (high vol, favors buyers)?

### Step 3: Compare PoP Variants
- Heston PoP > 60% for short premium → reasonable
- Heston and VG within 5% → high confidence
- Big divergence → be cautious, outcome is model-dependent

### Step 4: Read the Edge
- Positive → market underprices your strategy's odds (favorable)
- Negative → market overprices your strategy's safety (proceed with caution)
- Magnitude matters: ±5% is noise; ±20% is a strong signal

### Step 5: Size with VaR and ES
- Set position size so ES(5%) ≤ 2% of account (aggressive) or 1% (conservative)
- If VaR ≈ max loss, the strategy has thin margins — size small
- If VaR << max loss, you have room — but don't over-leverage

### Step 6: Cross-Reference with VRP (Toolbar Badge)
- **VRP > 5%** (green): implied vol is rich relative to realized vol.
  Short premium strategies have a structural edge — the premium you collect
  is historically generous.
- **VRP near 0%**: no systematic edge to selling premium. Be more selective.
- **VRP < −2%** (red): implied vol is cheap. Long premium strategies are
  favored; avoid selling premium.

---

## Quick Reference

| Metric | Good for Short Premium | Good for Long Premium |
|--------|----------------------|----------------------|
| R:R | 0.3–0.5 (accept low because PoP is high) | > 1.5 (need high because PoP is lower) |
| Heston PoP | > 60% | > 40% |
| EV | > 0 (PoP × MaxProfit > (1−PoP) × MaxLoss) | > 0 |
| Edge | > −10% | > +5% |
| VaR/ES ratio | ES < 1.3× VaR | Less relevant |
| VRP | > +5% | < −2% |
| Density shape | Narrow, inside profit | Wide, covers target move |
| Kelly fraction | > 0 (half-Kelly for sizing) | > 0 |

---

## Limitations

- **Uncalibrated models** produce indicative (not reliable) numbers. Heston and
  VG defaults are generic, not fitted to NIFTY's current vol surface. Once the
  calibrator runs, all metrics improve significantly.
- **Risk-neutral ≠ real-world.** These probabilities are under the pricing measure,
  not the physical measure. Real-world move probabilities can differ (typically
  the real-world density has a positive equity risk premium, making upside moves
  slightly more likely than risk-neutral suggests).
- **4-day expiry caveat.** Very short-dated options have gamma risk that the
  density doesn't fully capture — a single intraday spike can breach breakevens
  even if the density says it's unlikely.
- **Edge is model-dependent.** A −25% edge from uncalibrated Heston is less
  actionable than a −10% edge from a well-calibrated Heston. Always check
  calibration status in the IV Skew panel legend ("cal" vs "uncal").

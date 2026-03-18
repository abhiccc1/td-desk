# TD-Desk: Development Guide

> Real-time options trading dashboard for NSE & MCX.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start (Full Stack)](#quick-start-full-stack)
- [Frontend Setup](#frontend-setup)
  - [Local Development (without Docker)](#local-development-without-docker)
  - [Docker Development](#docker-development)
  - [Production Build](#production-build)
  - [Project Structure](#project-structure)
  - [Tech Stack](#tech-stack)
  - [Environment Variables](#environment-variables)
  - [Scripts](#scripts)
  - [Key Patterns](#key-patterns)
  - [Adding a New Panel](#adding-a-new-panel)
  - [Adding a shadcn/ui Component](#adding-a-shadcnui-component)
  - [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22+ | Frontend runtime |
| npm | 10+ | Frontend package manager |
| Python | 3.12+ | Backend services |
| Docker | 24+ | Container orchestration |
| Docker Compose | v2+ | Multi-service dev stack |

---

## Quick Start (Full Stack)

```bash
git clone <repo-url> td-desk && cd td-desk
cp .env.example .env
docker compose up
```

This starts all 7 services: Redis, TimescaleDB, 4 backend microservices, and the frontend dev server.

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| API Gateway | http://localhost:8000 |
| API Health Check | http://localhost:8000/health |

To run only the infrastructure (Redis + TimescaleDB) and develop frontend locally:

```bash
docker compose up -d redis timescaledb
cd frontend && npm run dev
```

---

## Frontend Setup

### Local Development (without Docker)

```bash
cd frontend

# 1. Install dependencies
npm install --legacy-peer-deps

# 2. Create environment file
cp .env.local.example .env.local

# 3. Start dev server
npm run dev
```

Open http://localhost:3000. The dev server supports hot module replacement — edits to files in `src/` are reflected instantly.

> **Note:** `--legacy-peer-deps` is required because `@visx/*` packages declare a peer dependency on React 16–18, but the project uses React 19. The libraries work correctly with React 19.

### Docker Development

From the project root:

```bash
# Start only the frontend in Docker
docker compose up frontend

# Or start with backend dependencies
docker compose up redis timescaledb api_gateway frontend
```

The Docker dev container (`Dockerfile.dev`) uses Node 22 Alpine, mounts `src/` and `public/` for live editing, and exposes port 3000.

### Production Build

```bash
cd frontend

# Build static export
npm run build

# Output is in ./out/ — serve with any static file server
npx serve out
```

The production Dockerfile produces an nginx image serving the static export:

```bash
# From project root
docker build -t td-desk-frontend -f frontend/Dockerfile frontend/
docker run -p 80:80 td-desk-frontend
```

### Project Structure

```
frontend/src/
├── app/                         # Next.js App Router
│   ├── layout.tsx               # Root layout — dark theme, monospace font
│   ├── page.tsx                 # Entry point — renders TradingDashboard
│   └── globals.css              # Tailwind base + custom styles
│
├── components/
│   ├── ui/                      # shadcn/ui primitives (button, etc.)
│   ├── dashboard/
│   │   ├── trading-dashboard.tsx  # Mosaic windowing container
│   │   └── panel-registry.tsx     # PanelId → component mapping
│   ├── option-chain/
│   │   ├── option-chain-panel.tsx  # Underlying/expiry selectors + grid
│   │   └── option-chain-grid.tsx   # AG Grid with applyTransactionAsync
│   ├── charts/
│   │   ├── price-chart-panel.tsx   # TradingView Lightweight Charts
│   │   └── payoff-diagram.tsx      # Visx payoff curve
│   ├── positions/
│   │   └── position-monitor.tsx    # AG Grid for positions + P&L
│   ├── order-basket/
│   │   ├── basket-panel.tsx        # Multi-leg strategy builder
│   │   └── leg-editor.tsx          # Individual leg row
│   └── greeks/
│       └── greeks-exposure.tsx     # Net Greek cards
│
├── stores/                      # Zustand state management
│   ├── market-data-store.ts     # Ticks, option chain (getState() pattern)
│   ├── basket-store.ts          # Order basket legs, net credit
│   ├── position-store.ts        # Positions, P&L
│   ├── greeks-store.ts          # Live Greeks, net aggregates
│   └── layout-store.ts          # Mosaic layout (persisted to localStorage)
│
├── lib/                         # Shared utilities
│   ├── ws-client.ts             # WebSocket with auto-reconnect
│   ├── api-client.ts            # REST API client
│   └── utils.ts                 # shadcn/ui cn() helper
│
└── types/                       # TypeScript type definitions
    ├── panels.ts                # PanelId union + titles
    ├── market-data.ts           # TickData, GreeksResult, StrategyResult, etc.
    └── orders.ts                # OrderRequest, Position, etc.
```

### Tech Stack

| Library | Version | Purpose |
|---------|---------|---------|
| Next.js | 16.1.6 | React framework (static export mode) |
| React | 19.2.3 | UI library |
| TypeScript | ^5 | Type safety |
| Tailwind CSS | ^4 | Utility-first styling |
| shadcn/ui | base-nova style | UI primitives (dark theme) |
| Zustand | ^5.0.11 | State management |
| react-mosaic-component | ^7.0.0-beta0 | Dockable panel windowing |
| ag-grid-community | ^35.1.0 | Virtualized data grids |
| ag-grid-react | ^35.1.0 | React wrapper for AG Grid |
| lightweight-charts | ^5.1.0 | TradingView candlestick charts |
| @visx/* | ^3.12.0 | D3-based SVG primitives (payoff diagrams) |

### Environment Variables

Create `frontend/.env.local` from the example:

```bash
cp .env.local.example .env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | API Gateway REST endpoint |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8000/ws/stream` | API Gateway WebSocket endpoint |

Both are prefixed with `NEXT_PUBLIC_` so they are available in the browser bundle.

### Scripts

```bash
npm run dev       # Start dev server with hot reload (port 3000)
npm run build     # Static export to ./out/
npm run start     # Start production server (requires non-export mode)
npm run lint      # Run ESLint
npx tsc --noEmit  # Type-check without emitting
```

### Key Patterns

#### High-Frequency Tick Injection (No React Re-renders)

The option chain and price chart receive 100+ updates/second. To avoid React reconciliation overhead:

1. **WebSocket → Zustand `getState()`**: Ticks bypass React entirely.
   ```ts
   // In ws-client.ts message handler
   useMarketDataStore.getState().updateTick(tick);
   ```

2. **AG Grid `applyTransactionAsync`**: Grid rows update directly via the API ref.
   ```ts
   // In option-chain-grid.tsx
   useMarketDataStore.subscribe((state) => {
     gridApi.applyTransactionAsync({ update: rows });
   });
   ```

3. **TradingView `series.update()`**: Chart updates via a direct series ref.
   ```ts
   // In price-chart-panel.tsx
   useMarketDataStore.subscribe((state) => {
     seriesRef.current.update(candleData);
   });
   ```

#### Mosaic Panel Layout

The dashboard uses `react-mosaic-component` for a terminal-like windowing experience. Layout state is controlled via Zustand and persisted to `localStorage`:

```ts
// layout-store.ts
const useLayoutStore = create(
  persist(
    (set) => ({
      layout: DEFAULT_LAYOUT,  // MosaicNode<PanelId> tree
      setLayout: (layout) => set({ layout }),
    }),
    { name: "td-desk-layout" }
  )
);
```

Users can drag, resize, and rearrange panels. The layout survives page refreshes.

#### Path Aliases

TypeScript is configured with `@/` mapping to `src/`:

```ts
import { useMarketDataStore } from "@/stores/market-data-store";
import type { TickData } from "@/types/market-data";
```

### Adding a New Panel

1. **Define the panel ID** in `types/panels.ts`:
   ```ts
   export type PanelId = "option-chain" | ... | "my-new-panel";
   export const PANEL_TITLES: Record<PanelId, string> = {
     ...,
     "my-new-panel": "My New Panel",
   };
   ```

2. **Create the component** in `components/my-panel/my-panel.tsx`:
   ```tsx
   "use client";
   export function MyPanel() {
     return <div className="p-4 text-[#e0e0e0]">Hello</div>;
   }
   ```

3. **Register it** in `components/dashboard/panel-registry.tsx`:
   ```tsx
   case "my-new-panel":
     return <MyPanel />;
   ```

The panel is now available in the Mosaic layout. To show it by default, update `DEFAULT_LAYOUT` in `stores/layout-store.ts`.

### Adding a shadcn/ui Component

```bash
cd frontend
npx shadcn@latest add <component-name>
```

> **Note:** If you hit peer dependency errors, run with `npm config set legacy-peer-deps true` first (already set if you followed the install instructions).

Components are installed to `src/components/ui/`. The project uses the **base-nova** style with **neutral** base color and CSS variables enabled.

### Troubleshooting

#### `npm install` fails with peer dependency errors

```bash
npm install --legacy-peer-deps
```

This is expected — Visx packages haven't updated their peer deps for React 19 yet.

#### `next build` fails with "window is not defined"

Components using browser-only libraries (react-mosaic, AG Grid, TradingView) must be dynamically imported with SSR disabled:

```tsx
const MyComponent = dynamic(() => import("@/components/my-component"), {
  ssr: false,
});
```

The root `page.tsx` already does this for `TradingDashboard`.

#### AG Grid styles missing

Ensure these CSS imports are present in the grid component:

```tsx
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
```

#### Layout resets on every page load

Check that `localStorage` is not being cleared. The layout store persists under the key `td-desk-layout`. To reset manually:

```js
localStorage.removeItem("td-desk-layout");
```

#### TypeScript errors after adding a new dependency

```bash
npx tsc --noEmit
```

If the error is in a third-party type definition, add it to `tsconfig.json` `exclude` or use a `// @ts-expect-error` with a comment explaining why.

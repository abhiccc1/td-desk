# TD Desk Mobile

Independent Android-focused mobile frontend for the TD Desk backend.

## Stack

- Expo SDK 55
- React Native
- Expo Router
- TanStack Query
- Zustand
- FlashList

This app is intentionally separate from the desktop/web frontend in `/frontend`. It does not import from the Next.js codebase. The shared boundary is only the backend API and WebSocket contract.

## Scope

This mobile MVP extracts the smallest useful trading workflow:

- Option chain selection
- One-tap handoff into quick order placement
- Positions and P&L monitoring
- Runtime API / WebSocket configuration for LAN access

## Run

```bash
cd mobile-app
npm install
npx expo start
```

For Android native project generation:

```bash
cd mobile-app
npx expo prebuild --platform android
npx expo run:android
```

## Backend URLs

When using a phone or Android emulator, do not use `localhost` unless the backend is running inside the same device context.

Examples:

```text
API: http://192.168.1.40:8000
WS:  ws://192.168.1.40:8000/ws/stream
```

The Settings screen normalizes missing schemes so `192.168.1.40:8000` becomes `http://192.168.1.40:8000`.

# Architecture

```
┌──────────────────────────── apps/mobile (Expo Router) ────────────────────────────┐
│ Screens: Home · Calibrate · Features · Plan Hunt · Results · Plan card · Hunt · Log │
│ Components: PhotoMap (SVG over photo, always offline) · GeoMap (MapLibre + USGS)   │
│ State: zustand store  ·  Storage: SQLCipher (expo-sqlite), key in Keychain/Keystore │
│ Services: NWS forecast · vision proxy · 3DEP/NLCD/CDL · offline packs · check-in   │
└──────────────┬──────────────────────────────────────────────────────┬─────────────┘
               │ import (pure TS, runs on device)                     │ HTTPS (opt.)
┌──────────────▼──────────────── packages/engine ──────┐   ┌──────────▼───────────────┐
│ planHunt(): phase → habitat → candidates → wind gate  │   │ server/vision-proxy       │
│ → routes → scoring → top 3 + backup → plan card       │   │ POST /v1/analyze-map      │
│ + calibration, vision schema/mock/client, NWS & USGS  │   │ → Claude (JSON schema)    │
│   clients (fetch injected), cross-check               │   │ auth token, rate limit    │
└───────────────────────────────────────────────────────┘   └──────────────────────────┘
```

## Key decisions

- **Engine is a separate package with zero runtime deps.** It runs offline on the phone, is tested in plain Node (`node --test`), and the proxy reuses its vision schema and prompt, so there is one contract.
- **Photo-first map.** `PhotoMap` draws everything over the hunter's own calibrated photo in SVG. It works with no network, no geo-reference and no tiles. `GeoMap` (MapLibre + USGS National Map, public-domain tiles with offline packs) is an upgrade once two reference points are set.
- **Local meters everywhere.** Calibration maps photo pixels ↔ local meters ↔ lat/lon. Rules never touch pixels or degrees.
- **Wind is a gate, not a weight.** Eliminated stands are listed with the exact reason ("Wind carries scent onto buck bedding (240 m E)"), so the hunter can see why the saddle is out today.
- **Never override the hunter.** Detections can be moved, retyped or dismissed (restorable); generated stands can be moved (they become the hunter's own) or dismissed (remembered); weather fields can be overridden (badged); phase and setback can be overridden. The hunter's stands always appear, scored or eliminated with reasons.
- **Claude via a proxy.** The app never holds an Anthropic key. The proxy uses `claude-opus-5-5` with structured JSON output (`output_config.format` json_schema), `effort: high` for spatial tracing, and server-side refusal fallback (`fallbacks: "default"`). Results are re-validated on both sides.

## UX rules implemented

- 56 px minimum touch targets (`TOUCH`), large type, one primary action per screen.
- Wind badge rendered once by the root layout, top-right, on every screen. Arrow points where scent goes.
- Status is always **color + icon** (✓ circle / ! triangle / ✕ octagon), so it still reads in red-light mode.
- Silent by default: no sounds anywhere; notifications are vibrate-only; haptics opt-in.
- Battery-aware: one-shot location only; Hunt mode refreshes wind every 15/30/60 min by battery level and Low Power Mode; red-light theme on a black background.
- Post-hunt log: one tap for the outcome, two toggles, notes by keyboard dictation.

## Status

**Verified here**

- Engine: `tsc` strict (incl. `erasableSyntaxOnly`) and 101 passing tests covering calibration math, NOAA sun times vs. published values, moon phase, phase calendar, scent/thermal gate, habitat inference, candidate rules, A* routing, scoring caps, planner integration, vision parsing, 3DEP/NLCD/CDL cross-check, NWS parsing, Albers projection, and weather safety gates.
- Proxy: request validation, auth parsing and rate limiting tested (4 tests).
- App: type-checked for internal consistency (screens ↔ components ↔ store ↔ engine) against minimal stubs of the React Native/Expo APIs.

**Not yet verified, because the npm registry was unreachable from the build environment**

- The app has not been compiled against the real React Native / Expo / MapLibre type packages, bundled with Metro, or run on a device. Expect a short fix-up pass on first `npm install && npx expo run:ios`: library prop names (especially `@maplibre/maplibre-react-native` v10 `OfflineManager.createPack` options and `MapView` style props), and `expo-notifications` trigger shapes.
- The proxy hasn't been type-checked against the installed `@anthropic-ai/sdk` or called live. It's pinned to `latest`; pin the resolved version after install.
- Live endpoint shapes for MRLC NLCD GetFeatureInfo (layer name, property key) and CropScape should be confirmed against a real request; the parsers already accept the common variants.

**Phase 2 candidates**

- True dead-man's-switch check-in (server-sent SMS when overdue; phones can't auto-text).
- On-device speech recognition for logs (Phase 1 uses keyboard dictation).
- Rut calendars for other regions; per-state legal-hour tables.
- Camera-photo sighting import with EXIF time/location; sightings heat map.
- Stand-level history analytics (which winds/phases produce mature-buck sightings).
- Drag-to-move on the map (Phase 1 uses tap-to-place, which is easier with gloves).

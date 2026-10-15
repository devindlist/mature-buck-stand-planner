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

- Engine: `tsc` strict (incl. `erasableSyntaxOnly`) and 165 passing tests covering calibration math, NOAA sun times vs. published values, moon phase, phase calendar, scent/thermal gate, habitat inference, candidate rules, A* routing (hard vs. soft blocks, unreachable stands, scent onto feeding deer), scoring caps, planner integration (worst-hour weather gate, wind-shift backups, legal-hour settings), vision parsing, 3DEP/NLCD/CDL cross-check (bounded concurrency, deadlines, failed-vs-no-data), NWS parsing, Albers projection, and weather safety gates.
- Proxy: request validation (shared 5,000,000-character image cap), fail-closed auth policy, timeout clamping, request-cancellation watcher and rate limiting tested (15 tests).
- App: type-checked for internal consistency (screens ↔ components ↔ store ↔ engine) against minimal stubs of the React Native/Expo APIs. The pure modules (wind-badge rules, the cancel helper, date/format helpers) have 19 tests that run in CI.

**Not yet verified, because the npm registry was unreachable from the build environment**

- The app has not been compiled against the real React Native / Expo / MapLibre type packages, bundled with Metro, or run on a device. Expect a short fix-up pass on first `npm install && npx expo run:ios`: library prop names (especially `@maplibre/maplibre-react-native` v10 `OfflineManager.createPack` options and `MapView` style props), and `expo-notifications` trigger shapes.
- The proxy typechecked against the real `@anthropic-ai/sdk` in CI (first push), but it has not been called live. It is pinned to a caret range with no lock file yet: run `npm install` once, make a live call, and commit `package-lock.json`.
- Live endpoint shapes for MRLC NLCD GetFeatureInfo (layer name, property key) and CropScape should be confirmed against a real request; the parsers already accept the common variants.

**Needs a real device to confirm** (library behavior that cannot be checked offline)

- `@maplibre/maplibre-react-native` v10: the offline pack is built from a `file://` style URL; confirm both native downloaders accept it (fallback: host the style JSON at an https URL). Also check that the data-driven layers and stand labels render on the USGS map.
- `expo-notifications` 0.29: the Android channel (vibrate, no sound) and iOS time-sensitive entitlement. A free Apple Personal Team build may need the entitlement removed (see the note in `src/services/checkin.ts`).
- SQLCipher: the app refuses to open storage on a build without it (`PRAGMA cipher_version` is checked), so a plain-SQLite build fails loudly instead of storing in the clear. Confirm the schema 1 → 2 migration (map photos move into the encrypted database) on a build that has real v1 data.
- Android 12+ exact alarms: `SCHEDULE_EXACT_ALARM` is declared but cannot be requested from JavaScript; without "Alarms & reminders" granted, check-in reminders can arrive late (Settings explains this).
- `newArchEnabled` is on: check the Results and Hunt maps on both platforms.

**Known limits**

- Hunt mode's sighting log records where the hunter sat, not where the deer was; a "Bedded" detail drops the position so it can never place a bed under the stand. Deer position, heading on the map and trail-cam sightings are Phase 2.
- Cancelling a map analysis stops the app waiting; the request to the proxy runs to its own deadline (the proxy cancels its Claude call when the phone disconnects or its deadline passes).
- Map photos are stored at the picker's resolution (as base64 text inside the encrypted database); very large photos use a lot of memory when a map is rebuilt.
- App-side logic that touches the phone (storage migration, hunt restore rules, alarms, screens) has no automated tests: it needs the real libraries. A Phase 2 task is a device-level smoke test and tests for those modules with the Expo libraries mocked.

**Phase 2 candidates**

- True dead-man's-switch check-in (server-sent SMS when overdue; phones can't auto-text).
- On-device speech recognition for logs (Phase 1 uses keyboard dictation).
- Rut calendars for other regions; per-state legal-hour defaults (Phase 1 has hunter-editable minutes before sunrise / after sunset, default 30/30).
- Camera-photo sighting import with EXIF time/location; sightings heat map.
- Stand-level history analytics (which winds/phases produce mature-buck sightings).
- Drag-to-move on the map (Phase 1 uses tap-to-place, which is easier with gloves).

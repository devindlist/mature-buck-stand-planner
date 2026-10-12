# Rules engine

`packages/engine` is a pure TypeScript module with no React Native imports and no runtime dependencies. It runs identically on the phone, in Node, and in tests (`npm test`, 101 tests via `node:test`). Every number below is a named constant in the source, so tuning is a one-line change with a failing or passing test next to it.

Conventions: local planar meters (x = east, y = north); bearings clockwise from true north; wind is meteorological (the direction it blows **from**); times are UTC ISO strings.

## 1. Season phase (`season/phase.ts`)

Midwest calendar (IA, IL, IN, OH, MO, KS, NE, WI, MN, MI, ND, SD). Breeding is photoperiod-driven and peaks around Nov 10–20 nearly every year.

| Phase | Starts | Bedding setback | PM settle before sunset | AM hold after sunrise |
|---|---|---|---|---|
| Early season | Sep 1 | 200 m | 3h | 2.5h |
| October lull | Oct 15 | 180 m | 2.5h | 2.5h |
| Pre-rut | Oct 25 | 120 m | 3.5h | 4h |
| Seeking & chasing | Nov 4 | 100 m | 4.5h | 5.5h (stay through midday) |
| Lockdown | Nov 13 | 80 m | 4h | 5h |
| Post-rut | Nov 23 | 150 m | 3h | 3h |
| Late season | Dec 11 | 180 m | 2.5h | 2.5h |

Doe bedding uses 60% of the setback. The hunter can override the phase and the setback; outside the Midwest the plan says the calendar isn't tuned for that state.

## 2. Features and cross-check (`vision/`)

The vision model returns normalized photo coordinates with confidence. `parseVisionResult` never throws: it drops malformed features and reports issues. When the photo is geo-referenced:

- **3DEP**: ridge/draw/creek profiles 60 m either side (≥ 1.5 m relief); saddle = higher along the ridge and lower across it; bench = flat shelf with steeper ground above and below.
- **NLCD**: thick cover / ag / mast / water against land-cover class.
- **CDL**: crop from last year's layer, with Midwest corn↔soy rotation applied ("CDL showed corn, so rotation suggests beans this year. Confirm.").

Agreement adds +0.15 confidence; disagreement subtracts 0.25. Nothing is deleted. User-placed features are never touched.

## 3. Habitat inference (`inference/habitat.ts`)

- **Bedding**: hunter-marked (0.95) › thick cover (0.55 × conf, +0.2 with a bench/ridge point, ×0.6 within 150 m of roads/houses, +0.05 if > 300 m remote) › bare benches (0.4). Cover tight to food without terrain = doe bedding. An observed bedded mature buck creates or boosts bedding.
- **Food**: crop × phase attraction table (e.g. green beans 0.95 early, standing beans 1.0 late, acorns 0.9 in the lull).
- **Corridors**, weighted by phase: bed→food (to the 3 best foods within 1.6 km), bed↔bed cruising, **downwind cruise lines** (80 m downwind of doe bedding, perpendicular to today's wind), and terrain travel (benches 1.0, edges 0.8, draws 0.7, ridges 0.6, creeks 0.4). Corridors bend through saddles, funnels, crossings and inside corners near the straight line; each pinch adds +15% strength (cap +30%).

## 4. Candidates (`stands/candidates.ts`)

Anchors: every pinch point; for bed→food, the bedding-side intercept (setback + 40 m), 70% toward food, and (PM early/late/post-rut) the field edge. Stands are offset 50% of effective range (15–90 m) to the **downwind side** of the corridor (both sides if the wind is within ~15° of parallel). Rejected: inside the setback, outside the boundary, within 10 m of a trail, in water, within 50 m of a road/house, or > 20 m into an open field. Spots the hunter dismissed are never proposed again. The hunter's own stands are always evaluated.

## 5. Wind gate (`wind/scent.ts`). Hard elimination.

| Wind | Plume |
|---|---|
| ≥ 6 mph | Straight downwind, 400 m. Half-angle 15° + 1°/mph of gust spread + ½ of the forecast direction swing (max 60°). |
| 2–6 mph | Wide wind plume (≤ 75°, 250 m) **plus thermals** if slope ≥ 4%: falling (downslope) and rising (upslope) 200 m plumes, because a sit spans both. |
| < 2 mph, terrain unknown | Swirl: 120 m in every direction. |

Slope comes from the 3DEP grid when geo-referenced, otherwise from mapped ridges and draws. A stand is **eliminated** if any plume reaches, within its hard range:

- bedding (prob ≥ 0.4): 400 m
- food deer are likely to use this sit (prob ≥ 0.3): 200 m PM / 150 m AM; beyond that it's a scored caution
- the **approach path**: the corridor stretch deer travel to reach the stand this sit (PM from the bedding end, AM from the food end; two-way corridors ±150 m)

Each hourly forecast wind inside the sit window is also tested; a failure there makes the stand NO-GO with "forecast swings to SW mid-sit".

## 6. Scoring (`stands/scoring.ts`). Survivors only, 0–100.

| Component | Max | Logic |
|---|---|---|
| Wind fit | 25 | 25 × min(1, margin/45°), where margin is how far the wind can swing before the gate fails; −gustiness; ×0.9 light wind with thermals, ×0.75 unknown thermals; −3 per soft food hit |
| Access stealth | 20 | A* entry and exit on a cost grid shaped by where deer are (AM in: on food; AM out / PM in: bedded; PM out: on food). −8 per red segment, −3 per amber; exit weighted 0.75; long or overlapping routes cost more |
| Movement | 20 | Best corridor in range (60% relative + 40% absolute strength), +pinch, +converging routes, ×0.6 for food-side AM sits outside the rut, **+observed sightings** (mature buck +0.25 each, up to +0.4) |
| Bedding distance | 10 | Full marks from setback to 2.5× setback; drops sharply inside the setback and slowly beyond |
| Shot | 10 | 0 if travel is beyond effective range or the lane points at a road/house; full at ≤ 60% of range |
| Cover | 5 | Distance to thick cover / mast / edge / draw / bench; blinds get 3.5 minimum |
| Pressure | 5 | Sits within 60 m in 14 days (0→5, 1→4, 2→2.5, 3+→1), −2 for deer bumped within 200 m in 7 days |
| Weather & time | 5 | Colder than normal, 5–12 mph steady wind, light precip, rut AM near bedding, non-rut PM near food, **plus low-confidence modifiers** |

## 7. Selection

Top 3 by score, at least 100 m apart (if the wind leaves fewer distinct setups, nearby alternate trees fill in and the plan says so). **Backup**: the best remaining survivor that is good in ≥ 2 wind sectors where #1 is bad. If none exists, the best stand eliminated today that works for the likely shift (forecast swing, then ±45°, ±90°), labeled "Only if the wind shifts to X" and never marked GO. The hunter's other stands are listed with full scores.

## 8. Low-confidence modifiers (`modifiers/modifiers.ts`)

Moon (±0.25: bright moon nudges AM, dark moon nudges PM) and pressure trend (rising after a front +0.25 to +0.5; sharply falling +0.4). Combined cap ±0.75, inside the 5-point weather bucket, always tagged "low confidence". **Observed data outranks them**: with sightings near the stand they are damped to 25%, and the "why" text says so.

## 9. Safety (`safety/safety.ts`)

Weather NO-GO: thunderstorm, freezing rain, gusts ≥ 35 mph, wind chill ≤ −15°F. CAUTION: sleet, gusts ≥ 25, wind chill ≤ 5°F, ≥ 85°F. Shot lanes: 8 × 45° sectors; any sector reaching a road or house within the weapon's danger distance (bow 150, crossbow 200, shotgun 800, muzzleloader/handgun/rifle 1000 yds) is no-shot. Harness and haul-line reminders on every stand. Legal hours default to 30 min before sunrise to 30 min after sunset, always paired with "verify your state's rules".

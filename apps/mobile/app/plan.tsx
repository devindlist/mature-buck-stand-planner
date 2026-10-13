import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import {
  BEDDING_SETBACK_M,
  PHASE_LABELS,
  SEASON_PHASES,
  compass16,
  derivePhase,
  downwindBearing,
  sunTimes,
  type PrecipType,
  type PressureTrend,
  type SeasonPhase,
  type WeaponType,
} from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useForecast, useForecastFreshness } from '../src/state/useForecast';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { WindArrow, LowConfidenceTag, StatusIcon } from '../src/components/Icons';
import { conditionsConfirmed, planLocation, runPlan, setApproxLocation, useApproxLocations } from '../src/services/planning';
import { currentLocation } from '../src/services/device';
import { addDays, fmtDate, fmtTime, todayLocal } from '../src/utils/format';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

const WEAPONS: readonly WeaponType[] = ['bow', 'crossbow', 'muzzleloader', 'shotgun', 'rifle'];
const DEFAULT_RANGE: Record<WeaponType, number> = { bow: 30, crossbow: 40, muzzleloader: 125, shotgun: 100, rifle: 250, handgun: 100 };
const DIRS = Array.from({ length: 16 }, (_, i) => i * 22.5);

/** Every precip type the rules know, so freezing rain (a climbing NO-GO) is never entered as sleet. */
const PRECIP: readonly PrecipType[] = ['none', 'rain', 'snow', 'sleet', 'freezing_rain', 'thunderstorm'];
const PRECIP_LABEL: Record<PrecipType, string> = { none: 'None', rain: 'Rain', snow: 'Snow', sleet: 'Sleet', freezing_rain: 'Freezing rain', thunderstorm: 'T-storm' };
/** Climbing hazard of each type (as the weather gate rates it), shown as an icon on the chip. */
const PRECIP_HAZARD: Partial<Record<PrecipType, 'caution' | 'avoid'>> = { sleet: 'caution', freezing_rain: 'avoid', thunderstorm: 'avoid' };

/** Sky-cover choices for hand entry; a forecast value lights the nearest one. */
const CLOUD: ReadonlyArray<{ pct: number; label: string }> = [
  { pct: 10, label: 'Clear' },
  { pct: 40, label: 'Partly' },
  { pct: 75, label: 'Mostly' },
  { pct: 100, label: 'Overcast' },
];
const cloudChoice = (pct: number | undefined): number | undefined => (pct === undefined ? undefined : pct < 25 ? 10 : pct < 60 ? 40 : pct < 90 ? 75 : 100);

/** Plan Hunt: everything auto-filled; every value overridable with big controls. */
export default function PlanHunt() {
  const t = useTheme();
  const property = useAppStore((s) => s.activeProperty());
  const draft = useAppStore((s) => s.draft);
  const weather = useAppStore((s) => s.weather);
  const weatherStatus = useAppStore((s) => s.weatherStatus);
  const weatherError = useAppStore((s) => s.weatherError);
  const setDraft = useAppStore((s) => s.setDraft);
  const setOverride = useAppStore((s) => s.setOverride);
  const clearOverrides = useAppStore((s) => s.clearOverrides);
  const set = useAppStore((s) => s.set);
  const refresh = useForecast();
  const fresh = useForecastFreshness();
  const approx = useApproxLocations((s) => (property ? s.byProperty[property.id] : undefined));
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  if (!property) return <Redirect href="/calibrate" />;
  const { loc } = planLocation(property, approx);
  const geo = !!property.calibration?.originGeo;
  const o = draft.overrides;
  const windFrom = o.windFromDeg ?? weather?.windFromDeg ?? 315;
  const windSpeed = o.windSpeedMph ?? weather?.windSpeedMph ?? 8;
  const gust = o.windGustMph ?? weather?.windGustMph ?? windSpeed;
  const temp = o.tempF ?? weather?.tempF ?? 45;
  const precip = o.precipType ?? weather?.precipType ?? 'none';
  const trend = o.pressureTrend ?? weather?.pressureTrend ?? 'unknown';
  const cloud = cloudChoice(o.cloudCoverPct ?? weather?.cloudCoverPct);
  let sun: ReturnType<typeof sunTimes> | null = null;
  try {
    sun = loc ? sunTimes(draft.date, loc.lat, loc.lon) : null;
  } catch {
    sun = null;
  }
  const phase = derivePhase(draft.date, property.stateCode, draft.phaseOverride);
  const edited = (k: keyof typeof o) => (o[k] !== undefined ? 'edited' : undefined);
  // Placeholder = no forecast: values are defaults until the hunter sets or confirms them.
  const unconfirmed = !!weather?.placeholder && !conditionsConfirmed(o);
  const windEdited = o.windFromDeg !== undefined || o.windSpeedMph !== undefined || o.windGustMph !== undefined;
  const ready = !!weather && fresh.current && !fresh.loading;

  /** Approximate location for a photo-only map: the phone's GPS, taken at or near the property. */
  const takeGpsLocation = async () => {
    setLocating(true);
    try {
      const g = await currentLocation();
      if (!g) {
        Alert.alert('No GPS fix', 'Allow location access and try again. The plan needs a location for sun times and legal hours.');
        return;
      }
      await setApproxLocation(property.id, g);
    } catch (e) {
      Alert.alert('No GPS fix', e instanceof Error ? e.message : 'Turn on location services and try again.');
    } finally {
      setLocating(false);
    }
  };

  /** The hunter vouches for every value shown (no forecast): they become the hunter's own entries. */
  const confirmConditions = () =>
    setOverride({ windFromDeg: windFrom, windSpeedMph: Math.round(windSpeed), windGustMph: Math.round(gust), tempF: Math.round(temp), precipType: precip });

  const doPlan = async () => {
    if (!weather || !loc) return;
    setBusy(true);
    try {
      // Latest draft: a confirmation tap just before this updates the overrides.
      const result = await runPlan(property, useAppStore.getState().draft, weather, loc);
      set({ plan: result, selectedStandId: result.plan.recommendations[0]?.stand.id ?? null });
      router.push('/results');
    } catch (e) {
      Alert.alert('Planning failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    // Only ever plan with the forecast for the sit shown on this screen.
    if (!ready) return;
    if (!loc) {
      Alert.alert('Where is this map?', 'This map has no coordinates. Sun times, legal hours and the forecast need an approximate location: use your phone\'s GPS at or near the property.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use my GPS', onPress: () => void takeGpsLocation() },
      ]);
      return;
    }
    if (unconfirmed) {
      Alert.alert(
        'No forecast for this sit',
        `These are default values, not a forecast:\n${compass16(windFrom)} ${Math.round(windSpeed)} mph, gusts ${Math.round(gust)} mph, ${Math.round(temp)}°F, precipitation: ${PRECIP_LABEL[precip].toLowerCase()}.\n\nThe wind decides which stands are safe. Confirm only if these match what you see and feel.`,
        [
          { text: 'Edit values', style: 'cancel' },
          {
            text: 'They are right: plan',
            onPress: () => {
              confirmConditions();
              void doPlan();
            },
          },
        ],
      );
      return;
    }
    await doPlan();
  };

  const dayChips = [0, 1, 2, 3].map((n) => addDays(todayLocal(), n));

  return (
    <Screen title="Plan hunt" onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 80 }}>
        <Text style={{ color: t.textDim, fontSize: font.sm }}>{property.name}</Text>

        {property.analysisMode === 'mock' ? (
          <Card style={{ borderColor: t.status.caution }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <StatusIcon status="caution" color={t.status.caution} size={22} />
              <Text style={{ color: t.text, fontWeight: '800', flex: 1 }}>Sample features, not from your photo</Text>
            </View>
            <Body dim>This map holds the mock-analysis sample farm. Bedding, food, roads and houses on it are made up, so a plan built on them is a demo. Replace them with what is really on your ground.</Body>
            <BigButton label="Review map features" kind="secondary" onPress={() => router.push('/features')} />
          </Card>
        ) : property.features.every((f) => f.status !== 'active') ? (
          <Card>
            <Body dim>No map features yet. Mark bedding, food, trails, roads and houses so the plan knows where deer live and where shots are never safe.</Body>
            <BigButton label="Mark map features" kind="secondary" onPress={() => router.push('/features')} />
          </Card>
        ) : null}

        {!geo ? (
          <Card style={!loc ? { borderColor: t.status.caution } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <StatusIcon status={loc ? 'safe' : 'caution'} color={loc ? t.status.safe : t.status.caution} size={22} />
              <Text style={{ color: t.text, fontWeight: '800', flex: 1 }}>{loc ? 'Using your approximate location' : 'This map has no coordinates'}</Text>
            </View>
            <Body dim>
              {loc
                ? `Sun times, legal hours and the forecast use the GPS position you gave (${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}). Elevation and land-cover checks stay off for this map.`
                : 'Sun times, legal hours and the forecast need a location. At or near the property, use your GPS. Elevation and land-cover checks stay off for this map.'}
            </Body>
            <BigButton label={loc ? 'Update from my GPS' : 'Use my GPS location'} kind={loc ? 'ghost' : 'secondary'} loading={locating} onPress={() => void takeGpsLocation()} />
            <BigButton
              label="Add coordinates to this map"
              kind="ghost"
              accessibilityHint="Pin this map to the ground with one known point. Your stands and features stay where they are."
              onPress={() => router.push({ pathname: '/calibrate', params: { anchor: property.id } })}
            />
          </Card>
        ) : null}

        <Label>DATE</Label>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {dayChips.map((d, i) => (
            <Pressable key={d} accessibilityRole="button" accessibilityState={{ selected: draft.date === d }} onPress={() => setDraft({ date: d })} style={{ flex: 1, minHeight: 56, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.date === d ? t.accent : t.surfaceAlt }}>
              <Text style={{ color: draft.date === d ? t.accentText : t.text, fontWeight: '800' }}>{i === 0 ? 'Today' : i === 1 ? 'Tmrw' : fmtDate(d).split(',')[0]}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 4 }}>
          {fmtDate(draft.date)} · {phase.label}
          {phase.source === 'user' ? ' (your override)' : ''}
        </Text>

        <Label>HUNT WINDOW</Label>
        <Segmented options={['AM', 'PM'] as const} value={draft.window} onChange={(w) => setDraft({ window: w })} labels={{ AM: `AM${sun ? ` · ↑ ${fmtTime(sun.sunrise)}` : ''}`, PM: `PM${sun ? ` · ↓ ${fmtTime(sun.sunset)}` : ''}` }} />

        <Label>
          WIND {unconfirmed ? '(defaults: not a forecast)' : windEdited ? '(edited by you)' : weather?.source === 'nws' ? '(NWS forecast)' : '(entered by you)'}
        </Label>
        <Card style={!fresh.current ? { opacity: 0.55 } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <WindArrow downwindDeg={downwindBearing(windFrom)} color={t.wind} size={56} />
            <View>
              <Text style={{ color: t.text, fontSize: font.xl, fontWeight: '900' }}>
                {compass16(windFrom)} {Math.round(windSpeed)} mph
              </Text>
              <Text style={{ color: t.textDim }}>
                gusts {Math.round(gust)} · scent blows {compass16(downwindBearing(windFrom))}
              </Text>
            </View>
          </View>
          <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 10 }}>Wind FROM (tap to override):</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {DIRS.map((d) => {
              const on = compass16(windFrom) === compass16(d);
              return (
                <Pressable key={d} accessibilityRole="button" accessibilityLabel={`Wind from ${compass16(d)}`} accessibilityState={{ selected: on }} onPress={() => setOverride({ windFromDeg: d })} style={{ width: '23%', minHeight: TOUCH, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surfaceAlt }}>
                  <Text style={{ color: on ? t.accentText : t.text, fontWeight: '800' }}>{compass16(d)}</Text>
                </Pressable>
              );
            })}
          </View>
          <Stepper label="Speed" value={Math.round(windSpeed)} onChange={(v) => setOverride({ windSpeedMph: v })} unit="mph" max={60} badge={edited('windSpeedMph')} />
          <Stepper label="Gusts" value={Math.round(gust)} onChange={(v) => setOverride({ windGustMph: v })} unit="mph" max={80} badge={edited('windGustMph')} />
          {Object.keys(o).length ? <BigButton label={weather?.placeholder ? 'Clear my entries' : 'Reset to forecast'} kind="ghost" onPress={clearOverrides} /> : null}
          {fresh.loading ? (
            <Text style={{ color: t.status.caution, fontSize: font.sm }}>Getting the forecast for this sit…</Text>
          ) : !fresh.current ? (
            <Text style={{ color: t.status.caution, fontSize: font.sm }}>These values are from another sit. Get the forecast for this one before you plan.</Text>
          ) : weatherStatus !== 'ok' ? (
            <Text style={{ color: t.status.caution, fontSize: font.sm }}>{weatherError ?? 'Forecast unavailable. Set the conditions by hand.'}</Text>
          ) : null}
          {loc && !fresh.loading && (weatherStatus === 'error' || weatherStatus === 'offline') ? <BigButton label="Retry forecast" kind="ghost" onPress={() => void refresh()} /> : null}
        </Card>

        <Label>WEATHER</Label>
        <Card>
          <Stepper label="Temperature" value={Math.round(temp)} onChange={(v) => setOverride({ tempF: v })} unit="°F" min={-40} max={110} badge={edited('tempF')} />
          <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 6 }}>Precipitation{edited('precipType') ? ' (edited)' : ''}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {PRECIP.map((p) => {
              const on = precip === p;
              const hazard = PRECIP_HAZARD[p];
              return (
                <Pressable
                  key={p}
                  accessibilityRole="button"
                  accessibilityLabel={`Precipitation: ${PRECIP_LABEL[p]}${hazard === 'avoid' ? ', climbing no-go' : hazard === 'caution' ? ', caution' : ''}`}
                  accessibilityState={{ selected: on }}
                  onPress={() => setOverride({ precipType: p })}
                  style={{ width: '31.5%', minHeight: TOUCH, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 4, paddingHorizontal: 4, backgroundColor: on ? t.accent : t.surfaceAlt }}
                >
                  {hazard ? <StatusIcon status={hazard} color={on ? t.accentText : t.status[hazard]} size={16} /> : null}
                  <Text numberOfLines={2} style={{ color: on ? t.accentText : t.text, fontWeight: '800', fontSize: font.sm, textAlign: 'center', flexShrink: 1 }}>
                    {PRECIP_LABEL[p]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <Text style={{ color: t.textDim, fontSize: font.sm }}>Pressure trend</Text>
            <LowConfidenceTag color={t.textDim} />
            <Text style={{ color: t.textDim, fontSize: font.xs }}>low-confidence modifier</Text>
          </View>
          <View style={{ marginTop: 6 }}>
            <Segmented options={['falling', 'steady', 'rising', 'unknown'] as readonly PressureTrend[]} value={trend} onChange={(v) => setOverride({ pressureTrend: v })} labels={{ falling: '↓', steady: '→', rising: '↑', unknown: '?' }} />
          </View>
          <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 10 }}>
            Cloud cover
            {o.cloudCoverPct !== undefined ? ' (edited)' : weather?.cloudCoverPct !== undefined ? ` (forecast ${Math.round(weather.cloudCoverPct)}%)` : ' (unknown: tap to set)'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
            {CLOUD.map((c) => {
              const on = cloud === c.pct;
              return (
                <Pressable
                  key={c.pct}
                  accessibilityRole="button"
                  accessibilityLabel={`Cloud cover: ${c.label}`}
                  accessibilityState={{ selected: on }}
                  onPress={() => setOverride({ cloudCoverPct: c.pct })}
                  style={{ flex: 1, minHeight: TOUCH, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surfaceAlt }}
                >
                  <Text style={{ color: on ? t.accentText : t.text, fontWeight: '800', fontSize: font.sm }}>{c.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {unconfirmed ? (
            <View style={{ marginTop: SPACE }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <LowConfidenceTag color={t.status.caution} size={20} />
                <Text style={{ color: t.status.caution, fontSize: font.sm, flex: 1 }}>No forecast: wind and weather are defaults. Set each to what you see, or confirm them.</Text>
              </View>
              <BigButton label="Confirm these conditions" kind="secondary" onPress={confirmConditions} />
            </View>
          ) : weather?.placeholder ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: SPACE }}>
              <StatusIcon status="safe" color={t.status.safe} size={18} />
              <Text style={{ color: t.textDim, fontSize: font.sm, flex: 1 }}>Conditions entered by you (no forecast). Re-check gusts and lightning before you climb.</Text>
            </View>
          ) : null}
        </Card>

        <Label>WEAPON & YOUR EFFECTIVE RANGE</Label>
        <Segmented options={WEAPONS} value={draft.weaponType} onChange={(w) => setDraft({ weaponType: w, rangeYds: DEFAULT_RANGE[w] })} labels={{ bow: 'Bow', crossbow: 'Xbow', muzzleloader: 'Muzz', shotgun: 'Shotgun', rifle: 'Rifle' }} />
        <Stepper label="Effective range (your honest max)" value={draft.rangeYds} onChange={(v) => setDraft({ rangeYds: v })} step={5} min={10} max={400} unit="yds" />

        <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced((v) => !v)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
          <Text style={{ color: t.accent, fontWeight: '800' }}>{advanced ? '▾' : '▸'} Phase & setback overrides</Text>
        </Pressable>
        {advanced ? (
          <Card>
            <Body dim>Calendar says {derivePhase(draft.date, property.stateCode).label}. If your cams and sightings say otherwise, trust them.</Body>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {[undefined, ...SEASON_PHASES].map((p) => {
                const on = draft.phaseOverride === p;
                return (
                  <Pressable
                    key={p ?? 'auto'}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => setDraft({ phaseOverride: p as SeasonPhase | undefined })}
                    style={{ minHeight: TOUCH, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center', backgroundColor: on ? t.accent : t.surfaceAlt }}
                  >
                    <Text style={{ color: on ? t.accentText : t.text, fontWeight: '700', fontSize: font.sm }}>{p ? PHASE_LABELS[p] : 'Auto'}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Stepper
              label="Stay this far from buck bedding"
              value={draft.setbackOverrideM ?? BEDDING_SETBACK_M[phase.phase]}
              onChange={(v) => setDraft({ setbackOverrideM: v })}
              step={10}
              min={40}
              max={400}
              unit="m"
              badge={draft.setbackOverrideM !== undefined ? 'edited' : 'phase default'}
            />
          </Card>
        ) : null}

        {weather && !fresh.current && !fresh.loading ? (
          <BigButton label="Get forecast for this sit" onPress={() => void refresh()} style={{ minHeight: 72, marginTop: SPACE }} />
        ) : (
          <BigButton
            label="Generate plan"
            loading={busy}
            disabled={!ready}
            sublabel={!ready ? 'Waiting for the forecast for this sit…' : unconfirmed ? 'Confirm the conditions first' : undefined}
            onPress={() => void generate()}
            style={{ minHeight: 72, marginTop: SPACE }}
          />
        )}
        <BigButton label="Review / edit map features" kind="ghost" onPress={() => router.push('/features')} />
      </ScrollView>
    </Screen>
  );
}

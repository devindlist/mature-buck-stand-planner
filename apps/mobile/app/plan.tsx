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
import { useForecast } from '../src/state/useForecast';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { WindArrow, LowConfidenceTag } from '../src/components/Icons';
import { propertyLocation, runPlan } from '../src/services/planning';
import { addDays, fmtDate, fmtTime, todayLocal } from '../src/utils/format';
import { font, RADIUS, SPACE } from '../src/theme/theme';

const WEAPONS: readonly WeaponType[] = ['bow', 'crossbow', 'muzzleloader', 'shotgun', 'rifle'];
const DEFAULT_RANGE: Record<WeaponType, number> = { bow: 30, crossbow: 40, muzzleloader: 125, shotgun: 100, rifle: 250, handgun: 100 };
const DIRS = Array.from({ length: 16 }, (_, i) => i * 22.5);

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
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  if (!property) return <Redirect href="/calibrate" />;
  const loc = propertyLocation(property);
  const o = draft.overrides;
  const windFrom = o.windFromDeg ?? weather?.windFromDeg ?? 315;
  const windSpeed = o.windSpeedMph ?? weather?.windSpeedMph ?? 8;
  const gust = o.windGustMph ?? weather?.windGustMph ?? windSpeed;
  const temp = o.tempF ?? weather?.tempF ?? 45;
  const precip = o.precipType ?? weather?.precipType ?? 'none';
  const trend = o.pressureTrend ?? weather?.pressureTrend ?? 'unknown';
  const sun = loc ? sunTimes(draft.date, loc.lat, loc.lon) : null;
  const phase = derivePhase(draft.date, property.stateCode, draft.phaseOverride);
  const edited = (k: keyof typeof o) => (o[k] !== undefined ? 'edited' : undefined);

  const generate = async () => {
    if (!weather) return;
    if (!loc) {
      Alert.alert('Map not geo-referenced', 'Sun times and legal hours need coordinates. Add two reference points to the map, or plan with an approximate location from your GPS.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Calibrate', onPress: () => router.push('/calibrate') },
      ]);
      return;
    }
    setBusy(true);
    try {
      const result = await runPlan(property, draft, weather, loc);
      set({ plan: result, selectedStandId: result.plan.recommendations[0]?.stand.id ?? null });
      router.push('/results');
    } catch (e) {
      Alert.alert('Planning failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const dayChips = [0, 1, 2, 3].map((n) => addDays(todayLocal(), n));

  return (
    <Screen title="Plan hunt" onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 80 }}>
        <Text style={{ color: t.textDim, fontSize: font.sm }}>{property.name}</Text>

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

        <Label>WIND {Object.keys(o).some((k) => k.startsWith('wind')) ? '(edited by you)' : weather?.source === 'nws' ? '(NWS forecast)' : '(manual)'}</Label>
        <Card>
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
                <Pressable key={d} accessibilityRole="button" accessibilityLabel={`Wind from ${compass16(d)}`} accessibilityState={{ selected: on }} onPress={() => setOverride({ windFromDeg: d })} style={{ width: '23%', minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surfaceAlt }}>
                  <Text style={{ color: on ? t.accentText : t.text, fontWeight: '800' }}>{compass16(d)}</Text>
                </Pressable>
              );
            })}
          </View>
          <Stepper label="Speed" value={Math.round(windSpeed)} onChange={(v) => setOverride({ windSpeedMph: v })} unit="mph" max={60} badge={edited('windSpeedMph')} />
          <Stepper label="Gusts" value={Math.round(gust)} onChange={(v) => setOverride({ windGustMph: v })} unit="mph" max={80} badge={edited('windGustMph')} />
          {Object.keys(o).length ? <BigButton label="Reset to forecast" kind="ghost" onPress={clearOverrides} /> : null}
          {weatherStatus !== 'ok' ? (
            <Text style={{ color: t.status.caution, fontSize: font.sm }}>{weatherStatus === 'loading' ? 'Loading forecast…' : weatherError ?? 'Forecast unavailable. Using manual values.'}</Text>
          ) : null}
          {weatherStatus === 'error' || weatherStatus === 'offline' ? <BigButton label="Retry forecast" kind="ghost" onPress={() => void refresh()} /> : null}
        </Card>

        <Label>WEATHER</Label>
        <Card>
          <Stepper label="Temperature" value={Math.round(temp)} onChange={(v) => setOverride({ tempF: v })} unit="°F" min={-40} max={110} badge={edited('tempF')} />
          <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 6 }}>Precipitation</Text>
          <View style={{ marginTop: 6 }}>
            <Segmented
              options={['none', 'rain', 'snow', 'sleet', 'thunderstorm'] as readonly PrecipType[]}
              value={precip === 'freezing_rain' ? 'sleet' : precip}
              onChange={(v) => setOverride({ precipType: v })}
              labels={{ none: 'None', rain: 'Rain', snow: 'Snow', sleet: 'Ice', thunderstorm: 'T-storm' }}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <Text style={{ color: t.textDim, fontSize: font.sm }}>Pressure trend</Text>
            <LowConfidenceTag color={t.textDim} />
            <Text style={{ color: t.textDim, fontSize: font.xs }}>low-confidence modifier</Text>
          </View>
          <View style={{ marginTop: 6 }}>
            <Segmented options={['falling', 'steady', 'rising', 'unknown'] as readonly PressureTrend[]} value={trend} onChange={(v) => setOverride({ pressureTrend: v })} labels={{ falling: '↓', steady: '→', rising: '↑', unknown: '?' }} />
          </View>
          {weather?.cloudCoverPct !== undefined ? <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 6 }}>Cloud cover {Math.round(weather.cloudCoverPct)}%</Text> : null}
        </Card>

        <Label>WEAPON & YOUR EFFECTIVE RANGE</Label>
        <Segmented options={WEAPONS} value={draft.weaponType} onChange={(w) => setDraft({ weaponType: w, rangeYds: DEFAULT_RANGE[w] })} labels={{ bow: 'Bow', crossbow: 'Xbow', muzzleloader: 'Muzz', shotgun: 'Shotgun', rifle: 'Rifle' }} />
        <Stepper label="Effective range (your honest max)" value={draft.rangeYds} onChange={(v) => setDraft({ rangeYds: v })} step={5} min={10} max={400} unit="yds" />

        <Pressable accessibilityRole="button" onPress={() => setAdvanced((v) => !v)} style={{ minHeight: 48, justifyContent: 'center' }}>
          <Text style={{ color: t.accent, fontWeight: '800' }}>{advanced ? '▾' : '▸'} Phase & setback overrides</Text>
        </Pressable>
        {advanced ? (
          <Card>
            <Body dim>Calendar says {derivePhase(draft.date, property.stateCode).label}. If your cams and sightings say otherwise, trust them.</Body>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {[undefined, ...SEASON_PHASES].map((p) => {
                const on = draft.phaseOverride === p;
                return (
                  <Pressable key={p ?? 'auto'} onPress={() => setDraft({ phaseOverride: p as SeasonPhase | undefined })} style={{ minHeight: 44, paddingHorizontal: 10, borderRadius: 10, justifyContent: 'center', backgroundColor: on ? t.accent : t.surfaceAlt }}>
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

        <BigButton label="Generate plan" loading={busy} disabled={!weather} onPress={generate} style={{ minHeight: 72, marginTop: SPACE }} />
        <BigButton label="Review / edit map features" kind="ghost" onPress={() => router.push('/features')} />
      </ScrollView>
    </Screen>
  );
}

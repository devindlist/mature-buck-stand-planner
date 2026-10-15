import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { assessWeather, derivePhase, sunTimes, type LatLon, type SeasonPhase, type WeatherSnapshot } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font, RADIUS } from '../theme/theme';
import { fmtTime } from '../utils/format';
import { LowConfidenceTag, StatusIcon } from './Icons';
import { effectiveWeather, legalHoursSetting } from '../services/planning';
import { useAppStore, type PlanDraft } from '../state/store';

/**
 * Home-screen conditions: temp, pressure trend, legal light, sun, phase, weather gate.
 * Shows the conditions the plan will use: the forecast with the hunter's overrides
 * applied. Placeholder values (no forecast) never get a weather all-clear.
 */
export function ConditionsStrip({
  weather,
  location,
  date,
  stateCode,
  status,
  note,
  overrides,
  phaseOverride,
  approximateLocation,
}: {
  weather: WeatherSnapshot | null;
  location?: LatLon;
  date: string;
  stateCode: string;
  status: string;
  note?: string;
  /** The hunter's draft overrides; applied before the weather gate is assessed. */
  overrides?: PlanDraft['overrides'];
  phaseOverride?: SeasonPhase;
  /** True when `location` is the hunter's approximate GPS position, not the map's. */
  approximateLocation?: boolean;
}) {
  const t = useTheme();
  // Legal light uses the hunter's own offsets (Settings), the same ones the plan is made with.
  const legalMinutesBefore = useAppStore((s) => s.settings.legalMinutesBefore);
  const legalMinutesAfter = useAppStore((s) => s.settings.legalMinutesAfter);
  let sun: ReturnType<typeof sunTimes> | null = null;
  try {
    sun = location ? sunTimes(date, location.lat, location.lon) : null;
  } catch {
    sun = null;
  }
  const legal = sun ? legalHoursSetting(sun, { legalMinutesBefore, legalMinutesAfter }) : null;
  const phase = derivePhase(date, stateCode, phaseOverride);
  const w = weather ? effectiveWeather(weather, overrides ?? {}) : null;
  const gate = w ? assessWeather(w) : null;
  // Defaults nobody has checked: only a hazard the hunter entered is worth showing.
  const unconfirmed = !!w?.placeholder && gate?.status !== 'no_go';
  const edited = (field: string) => (w?.overriddenFields.includes(field) ? 'edited by you' : undefined);
  const cell = (label: string, value: string, sub?: string) => (
    <View key={label} style={{ minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, marginRight: 8 }}>
      <Text style={{ color: t.textDim, fontSize: font.xs, fontWeight: '700' }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={{ color: t.textDim, fontSize: font.xs }}>{sub}</Text> : null}
    </View>
  );
  const trendArrow = w?.pressureTrend === 'rising' ? '↑' : w?.pressureTrend === 'falling' ? '↓' : w?.pressureTrend === 'steady' ? '→' : '?';
  const gateColor = gate ? t.status[gate.status === 'go' ? 'safe' : gate.status === 'caution' ? 'caution' : 'avoid'] : t.textDim;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6 }}>
        {unconfirmed ? (
          <View
            accessibilityLabel="Weather unknown: no forecast loaded"
            style={{ minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, borderWidth: 1.5, borderColor: t.status.caution, marginRight: 8, alignItems: 'center' }}
          >
            <LowConfidenceTag color={t.status.caution} size={22} />
            <Text style={{ color: t.text, fontSize: font.xs, fontWeight: '800', marginTop: 2 }}>WX ?</Text>
            <Text style={{ color: t.textDim, fontSize: font.xs }}>no forecast</Text>
          </View>
        ) : gate ? (
          <View
            accessibilityLabel={gate.status === 'go' ? 'Weather OK' : gate.status === 'caution' ? 'Weather caution' : 'Weather no-go'}
            style={{ minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, borderWidth: 1.5, borderColor: gateColor, marginRight: 8, alignItems: 'center' }}
          >
            <StatusIcon status={gate.status} color={gateColor} size={22} />
            <Text style={{ color: t.text, fontSize: font.xs, fontWeight: '800', marginTop: 2 }}>{gate.status === 'go' ? 'WX OK' : gate.status === 'caution' ? 'WX CAUTION' : 'WX NO-GO'}</Text>
          </View>
        ) : null}
        {w ? cell('TEMP', `${Math.round(w.tempF)}°F`, edited('tempF') ?? (w.windChillF !== undefined && w.windChillF < w.tempF - 2 ? `feels ${w.windChillF}°` : undefined)) : null}
        {w ? cell('PRESSURE', `${trendArrow} ${w.pressureTrend}`, 'low confidence') : null}
        {w?.cloudCoverPct !== undefined ? cell('CLOUD', `${Math.round(w.cloudCoverPct)}%`, edited('cloudCoverPct')) : null}
        {w && w.precipType !== 'none' ? cell('PRECIP', w.precipType.replace('_', ' '), edited('precipType') ?? (w.precipChancePct !== undefined ? `${w.precipChancePct}%` : undefined)) : null}
        {legal ? cell('LEGAL LIGHT', fmtTime(legal.start), `to ${fmtTime(legal.end)}${approximateLocation ? ' · approx.' : ''}`) : null}
        {sun ? cell('SUN', `↑ ${fmtTime(sun.sunrise)}`, `↓ ${fmtTime(sun.sunset)}`) : null}
        {cell('PHASE', phase.label, phase.source === 'user' ? 'your override' : phase.regionTuned ? undefined : 'not tuned here')}
      </ScrollView>
      <Text style={{ color: t.textDim, fontSize: font.xs }}>
        {status === 'loading' || status === 'idle'
          ? 'Getting NWS forecast…'
          : status === 'offline'
            ? note ?? 'Offline: last downloaded forecast.'
            : status === 'error'
              ? note ?? (w ? 'Forecast unavailable. Set the conditions by hand.' : '')
              : w?.placeholder
                ? 'No forecast: default values, confirm them on Plan Hunt.'
                : w?.source === 'nws'
                  ? `NWS forecast · ${w.shortForecast ?? ''}`
                  : w?.source === 'mixed'
                    ? `NWS forecast, edited by you${w.shortForecast ? ` · ${w.shortForecast}` : ''}`
                    : w
                      ? 'Conditions entered by you'
                      : ''}
        {approximateLocation ? '  ·  Sun times use your approximate GPS location.' : ''}
        {legal ? '  ·  Legal hours vary by state, so verify yours.' : ''}
      </Text>
    </View>
  );
}

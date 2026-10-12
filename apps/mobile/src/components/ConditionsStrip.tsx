import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { derivePhase, legalHours, sunTimes, type LatLon, type WeatherSnapshot } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font, RADIUS } from '../theme/theme';
import { fmtTime } from '../utils/format';
import { StatusIcon } from './Icons';
import { assessWeather } from '@msp/engine';

/** Home-screen conditions: temp, pressure trend, legal light, sun, phase, weather gate. */
export function ConditionsStrip({ weather, location, date, stateCode, status, note }: { weather: WeatherSnapshot | null; location?: LatLon; date: string; stateCode: string; status: string; note?: string }) {
  const t = useTheme();
  const sun = location ? sunTimes(date, location.lat, location.lon) : null;
  const legal = sun ? legalHours(sun) : null;
  const phase = derivePhase(date, stateCode);
  const gate = weather ? assessWeather(weather) : null;
  const cell = (label: string, value: string, sub?: string) => (
    <View key={label} style={{ minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, marginRight: 8 }}>
      <Text style={{ color: t.textDim, fontSize: font.xs, fontWeight: '700' }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={{ color: t.textDim, fontSize: font.xs }}>{sub}</Text> : null}
    </View>
  );
  const trendArrow = weather?.pressureTrend === 'rising' ? '↑' : weather?.pressureTrend === 'falling' ? '↓' : weather?.pressureTrend === 'steady' ? '→' : '?';
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6 }}>
        {gate ? (
          <View style={{ minWidth: 92, paddingHorizontal: 12, paddingVertical: 10, borderRadius: RADIUS, borderWidth: 1.5, borderColor: t.status[gate.status === 'go' ? 'safe' : gate.status === 'caution' ? 'caution' : 'avoid'], marginRight: 8, alignItems: 'center' }}>
            <StatusIcon status={gate.status} color={t.status[gate.status === 'go' ? 'safe' : gate.status === 'caution' ? 'caution' : 'avoid']} size={22} />
            <Text style={{ color: t.text, fontSize: font.xs, fontWeight: '800', marginTop: 2 }}>{gate.status === 'go' ? 'WX OK' : gate.status === 'caution' ? 'WX CAUTION' : 'WX NO-GO'}</Text>
          </View>
        ) : null}
        {weather ? cell('TEMP', `${Math.round(weather.tempF)}°F`, weather.windChillF !== undefined && weather.windChillF < weather.tempF - 2 ? `feels ${weather.windChillF}°` : undefined) : null}
        {weather ? cell('PRESSURE', `${trendArrow} ${weather.pressureTrend}`, 'low confidence') : null}
        {weather?.cloudCoverPct !== undefined ? cell('CLOUD', `${Math.round(weather.cloudCoverPct)}%`) : null}
        {weather && weather.precipType !== 'none' ? cell('PRECIP', weather.precipType.replace('_', ' '), `${weather.precipChancePct ?? 0}%`) : null}
        {legal ? cell('LEGAL LIGHT', fmtTime(legal.start), `to ${fmtTime(legal.end)}`) : null}
        {sun ? cell('SUN', `↑ ${fmtTime(sun.sunrise)}`, `↓ ${fmtTime(sun.sunset)}`) : null}
        {cell('PHASE', phase.label, phase.regionTuned ? undefined : 'not tuned here')}
      </ScrollView>
      <Text style={{ color: t.textDim, fontSize: font.xs }}>
        {status === 'loading' ? 'Getting NWS forecast…' : status === 'offline' ? note ?? 'Offline: last downloaded forecast.' : status === 'error' ? note ?? 'Forecast unavailable. Set wind by hand.' : weather?.source === 'nws' ? `NWS forecast · ${weather.shortForecast ?? ''}` : weather ? 'Manual conditions' : ''}
        {legal ? '  ·  Legal hours vary by state, so verify yours.' : ''}
      </Text>
    </View>
  );
}

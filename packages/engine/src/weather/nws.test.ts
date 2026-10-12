import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverrides,
  buildSnapshot,
  durationMs,
  fetchSnapshot,
  parseGridData,
  parseHourly,
  parseObservations,
  parsePoint,
  parseWindSpeed,
  precipFromForecast,
  pressureTrend,
} from './nws.ts';
import { assessWeather, windChillF } from '../safety/safety.ts';
import { weather } from '../test/fixtures.ts';

const POINT = {
  properties: {
    forecastHourly: 'https://api.weather.gov/gridpoints/DMX/60,80/forecast/hourly',
    forecastGridData: 'https://api.weather.gov/gridpoints/DMX/60,80',
    observationStations: 'https://api.weather.gov/gridpoints/DMX/60,80/stations',
    timeZone: 'America/Chicago',
    relativeLocation: { properties: { city: 'Nevada', state: 'IA' } },
  },
};

const period = (start: string, dir: string, speed: string, temp: number, forecast = 'Mostly Sunny', pop = 0) => ({
  startTime: start,
  endTime: new Date(Date.parse(start) + 3_600_000).toISOString(),
  temperature: temp,
  temperatureUnit: 'F',
  windSpeed: speed,
  windDirection: dir,
  probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: pop },
  shortForecast: forecast,
});

const HOURLY = {
  properties: {
    periods: [
      period('2026-11-07T18:00:00-06:00', 'NW', '10 mph', 41),
      period('2026-11-07T19:00:00-06:00', 'NW', '5 to 10 mph', 40),
      period('2026-11-07T20:00:00-06:00', 'WNW', '8 mph', 38),
      period('2026-11-07T21:00:00-06:00', 'W', '6 mph', 36, 'Chance Rain Showers', 40),
      period('2026-11-07T22:00:00-06:00', 'W', '5 mph', 35),
    ].map((p) => ({ ...p, startTime: new Date(p.startTime).toISOString() })),
  },
};

const GRID = {
  properties: {
    windGust: { uom: 'wmoUnit:km_h-1', values: [{ validTime: '2026-11-08T00:00:00+00:00/PT6H', value: 32.2 }] },
    skyCover: { values: [{ validTime: '2026-11-08T00:00:00+00:00/PT3H', value: 45 }] },
  },
};

const OBS = {
  features: [
    { properties: { timestamp: '2026-11-07T15:00:00Z', barometricPressure: { value: 101500 } } },
    { properties: { timestamp: '2026-11-07T17:00:00Z', barometricPressure: { value: 101620 } } },
    { properties: { timestamp: '2026-11-07T18:00:00Z', barometricPressure: { value: 101700 } } },
  ],
};

test('point parsing and US-only coverage', () => {
  const p = parsePoint(POINT);
  assert.equal(p.state, 'IA');
  assert.ok(p.forecastHourlyUrl.endsWith('/hourly'));
  assert.throws(() => parsePoint({ title: 'Data Unavailable For Requested Point' }), /US only/);
});

test('wind speed strings and durations', () => {
  assert.equal(parseWindSpeed('10 mph'), 10);
  assert.equal(parseWindSpeed('5 to 15 mph'), 15);
  assert.equal(parseWindSpeed(undefined), 0);
  assert.equal(durationMs('PT3H'), 3 * 3_600_000);
  assert.equal(durationMs('P1DT6H'), 30 * 3_600_000);
});

test('hourly periods parse direction to degrees', () => {
  const h = parseHourly(HOURLY);
  assert.equal(h[0].windFromDeg, 315);
  assert.equal(h[2].windFromDeg, 292.5);
  assert.equal(h[1].windSpeedMph, 10);
});

test('pressure trend from station observations', () => {
  const obs = parseObservations(OBS);
  assert.equal(obs.length, 3);
  const t = pressureTrend(obs);
  assert.equal(t.trend, 'rising');
  assert.equal(t.latest, 1017);
  assert.equal(pressureTrend([obs[2]]).trend, 'unknown');
});

test('precip keywords map to hazard types', () => {
  assert.equal(precipFromForecast('Chance Showers And Thunderstorms', 30), 'thunderstorm');
  assert.equal(precipFromForecast('Freezing Rain', 80), 'freezing_rain');
  assert.equal(precipFromForecast('Slight Chance Rain', 10), 'none');
  assert.equal(precipFromForecast('Rain Likely', 70), 'rain');
  assert.equal(precipFromForecast('Snow Showers', 60), 'snow');
});

test('snapshot for a PM sit picks mid-window conditions and keeps hourly winds', () => {
  const snap = buildSnapshot(parseHourly(HOURLY), parseGridData(GRID), parseObservations(OBS), '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', 'wx');
  assert.equal(snap.source, 'nws');
  assert.equal(snap.hourly?.length, 4);
  assert.equal(snap.precipType, 'rain', 'worst hour wins');
  assert.equal(snap.pressureTrend, 'rising');
  assert.ok(snap.windGustMph >= 19 && snap.windGustMph <= 21, `${snap.windGustMph} mph from 32.2 km/h`);
  assert.throws(() => buildSnapshot(parseHourly(HOURLY), null, [], '2027-01-01T00:00:00Z', '2027-01-01T04:00:00Z', 'x'), /No forecast/);
});

test('hunter overrides win and are recorded', () => {
  const snap = buildSnapshot(parseHourly(HOURLY), null, [], '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', 'wx');
  const o = applyOverrides(snap, { windFromDeg: 180, windSpeedMph: 12 });
  assert.equal(o.windFromDeg, 180);
  assert.equal(o.source, 'mixed');
  assert.deepEqual(o.overriddenFields.sort(), ['windFromDeg', 'windSpeedMph']);
  assert.ok(o.hourly?.every((h) => h.windFromDeg === 180), 'manual wind replaces the forecast trend');
  assert.equal(applyOverrides(snap, {}), snap);
});

test('fetchSnapshot walks points → hourly/grid/stations → observations with a User-Agent', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    assert.ok((init?.headers as Record<string, string>)['User-Agent'].includes('StandPlanner'));
    const body = url.includes('/points/')
      ? POINT
      : url.endsWith('/hourly')
        ? HOURLY
        : url.endsWith('/stations')
          ? { features: [{ properties: { stationIdentifier: 'KAMW' } }] }
          : url.includes('/observations')
            ? OBS
            : GRID;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const { snapshot, point } = await fetchSnapshot({ lat: 41.85, lon: -93.3 }, '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', { fetchFn: fakeFetch, userAgent: 'StandPlanner/0.1 (contact@example.com)' });
  assert.equal(point.city, 'Nevada');
  assert.equal(snapshot.pressureTrend, 'rising');
  assert.ok(seen.some((u) => u.includes('/stations/KAMW/observations')));
});

test('weather safety gates', () => {
  assert.equal(assessWeather(weather()).status, 'go');
  assert.equal(assessWeather(weather({ precipType: 'thunderstorm' })).status, 'no_go');
  assert.equal(assessWeather(weather({ precipType: 'freezing_rain' })).status, 'no_go');
  assert.equal(assessWeather(weather({ windGustMph: 38 })).status, 'no_go');
  assert.equal(assessWeather(weather({ windGustMph: 27 })).status, 'caution');
  assert.equal(assessWeather(weather({ tempF: -5, windSpeedMph: 15, windChillF: undefined })).status, 'no_go');
  assert.ok(Math.abs(windChillF(0, 15) - -19) < 1, 'NWS chart: 0°F @ 15 mph ≈ -19°F');
});

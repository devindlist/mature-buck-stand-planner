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

test('the /points lookup sends the location rounded to 3 decimals, never the exact position', async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string) => {
    seen.push(url);
    if (url.includes('/points/')) return new Response(JSON.stringify(POINT), { status: 200 });
    throw new Error('stop after /points');
  }) as unknown as typeof fetch;
  await assert.rejects(fetchSnapshot({ lat: 41.851234, lon: -93.309876 }, '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', { fetchFn: fakeFetch, userAgent: 'StandPlanner/0.1' }));
  const points = seen.find((u) => u.includes('/points/'));
  assert.ok(points?.endsWith('/points/41.851,-93.310'), points);
  assert.ok(!seen.some((u) => /41\.8512|93\.3098/.test(u)), 'no 4+ decimal coordinates leave the phone');
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

test('weather gates use the worst hour of the sit, not just the snapshot hour', () => {
  const sit = (gusts: number[], temps: number[], speed = 25) =>
    gusts.map((g, i) => ({ at: `2026-12-15T2${i}:00:00.000Z`, windFromDeg: 315, windSpeedMph: speed, windGustMph: g, tempF: temps[i] }));
  // The snapshot (midpoint hour) is calm and mild; the other hours are not.
  const calmMid = weather({ windGustMph: 15, windSpeedMph: 10, tempF: 55, windChillF: undefined });
  const gusty = { ...calmMid, hourly: sit([40, 40, 15, 40], [55, 55, 55, 55], 12) };
  const g = assessWeather(gusty);
  assert.equal(g.status, 'no_go', 'one-arg call reads the snapshot hourly');
  assert.match(g.reasons[0], /Gusts to 40 mph during the sit/);
  assert.equal(assessWeather(calmMid, gusty.hourly).status, 'no_go', 'explicit hourly list');
  assert.equal(assessWeather(gusty, []).status, 'go', 'an empty list means only the snapshot');
  // Cold front: the last hour is -2°F in 25 mph wind (wind chill about -27°F).
  const front = { ...calmMid, tempF: 20, hourly: sit([30, 30, 30, 30], [20, 15, 8, -2]) };
  const f = assessWeather(front);
  assert.equal(f.status, 'no_go');
  assert.ok(f.reasons.some((r) => /Wind chill -2\d°F during the sit/.test(r)), f.reasons.join(' | '));
  // Heat in any hour of an early-season sit.
  assert.equal(assessWeather({ ...calmMid, tempF: 80, hourly: sit([10, 10], [80, 88], 5) }).status, 'caution');
  // Hand-entered gusts and temperature win over the forecast hours.
  assert.equal(assessWeather({ ...gusty, overriddenFields: ['windGustMph'] }).status, 'go');
  assert.notEqual(assessWeather({ ...front, overriddenFields: ['tempF', 'windGustMph'] }).status, 'no_go');
});

test('placeholder conditions (no forecast) are never an all-clear', () => {
  const d = assessWeather(weather({ placeholder: true }));
  assert.equal(d.status, 'caution');
  assert.match(d.reasons.join(' '), /No forecast loaded/);
  assert.equal(assessWeather(weather()).status, 'go');
});

test('missing or variable NWS wind directions never read as north', () => {
  const body = {
    properties: {
      periods: [
        period('2026-11-08T00:00:00Z', 'W', '9 mph', 40),
        period('2026-11-08T01:00:00Z', 'VRB', '3 mph', 39),
        period('2026-11-08T02:00:00Z', '', '3 mph', 38),
        { ...period('2026-11-08T03:00:00Z', 'W', '8 mph', 37), windDirection: undefined },
        period('2026-11-08T04:00:00Z', 'SW', '8 mph', 36),
      ],
    },
  };
  const h = parseHourly(body);
  assert.deepEqual(
    h.map((x) => [x.windFromDeg, x.windDirKnown]),
    [
      [270, true],
      [270, false],
      [270, false],
      [225, false],
      [225, true],
    ],
  );
  const snap = buildSnapshot(h, null, [], '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', 'wx');
  assert.ok(snap.hourly?.every((x) => x.windFromDeg !== 0), 'no phantom north wind in the shift check');
  const allVrb = { properties: { periods: [period('2026-11-08T00:00:00Z', 'VRB', '2 mph', 40), period('2026-11-08T01:00:00Z', 'VRB', '2 mph', 40)] } };
  assert.throws(() => buildSnapshot(parseHourly(allVrb), null, [], '2026-11-08T00:00:00Z', '2026-11-08T02:00:00Z', 'wx'), /variable/);
});

test('pressure trend never mixes station and sea-level pressure', () => {
  // Steady air: the barometric and sea-level fields simply differ by ~1.6 hPa.
  const obs = parseObservations({
    features: [
      { properties: { timestamp: '2026-11-07T15:00:00Z', barometricPressure: { value: 101850 }, seaLevelPressure: { value: 101690 } } },
      { properties: { timestamp: '2026-11-07T16:00:00Z', barometricPressure: { value: 101855 }, seaLevelPressure: { value: 101692 } } },
      { properties: { timestamp: '2026-11-07T18:00:00Z', barometricPressure: { value: null }, seaLevelPressure: { value: 101690 } } },
    ],
  });
  assert.deepEqual(
    obs.map((o) => o.field),
    ['baro', 'baro', 'slp'],
  );
  const t = pressureTrend(obs);
  assert.equal(t.trend, 'steady', 'the barometric series alone is steady (mixing fields read as falling)');
  assert.equal(t.latest, 1018.55);
  // Two sea-level readings and one barometric: the sea-level series is used on its own.
  const slpOnly = parseObservations({
    features: [
      { properties: { timestamp: '2026-11-07T15:00:00Z', seaLevelPressure: { value: 101690 } } },
      { properties: { timestamp: '2026-11-07T17:00:00Z', barometricPressure: { value: 101850 } } },
      { properties: { timestamp: '2026-11-07T18:00:00Z', seaLevelPressure: { value: 101700 } } },
    ],
  });
  assert.equal(pressureTrend(slpOnly).trend, 'steady');
  assert.equal(pressureTrend(slpOnly).latest, 1017);
});

test('the observed pressure trend is not applied to a sit days away', () => {
  const later = {
    properties: { periods: [period('2026-11-10T22:00:00Z', 'NW', '9 mph', 40), period('2026-11-10T23:00:00Z', 'NW', '9 mph', 39)] },
  };
  const snap = buildSnapshot(parseHourly(later), null, parseObservations(OBS), '2026-11-10T22:00:00Z', '2026-11-11T00:00:00Z', 'wx');
  assert.equal(snap.pressureTrend, 'unknown');
  assert.equal(snap.pressureChange3hHpa, undefined);
  // A sit starting a few hours after the latest observation keeps it.
  const soon = buildSnapshot(parseHourly(HOURLY), null, parseObservations(OBS), '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', 'wx');
  assert.equal(soon.pressureTrend, 'rising');
});

test('NWS requests time out instead of hanging, so the app can fall back to its cache', async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(fetchSnapshot({ lat: 41.85, lon: -93.3 }, '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', { fetchFn: hang, userAgent: 'StandPlanner/0.1', timeoutMs: 40 }), /timed out/);
  // Even a fetch that ignores the abort signal gives up.
  const deaf = (() => new Promise(() => {})) as unknown as typeof fetch;
  await assert.rejects(fetchSnapshot({ lat: 41.85, lon: -93.3 }, '2026-11-08T00:00:00Z', '2026-11-08T04:00:00Z', { fetchFn: deaf, userAgent: 'StandPlanner/0.1', timeoutMs: 40 }), /timed out/);
  assert.ok(Date.now() - t0 < 2000);
});

import type { MapFeature, PlanInputs, Property, Vec, WeatherSnapshot } from '../models.ts';
import { calibrationFromNorthAndScale, normalizedToLocal } from '../calibration/calibration.ts';
import { MOCK_VISION_RESULT } from '../vision/mock.ts';
import { visionToFeatures } from '../vision/schema.ts';

/** 1000×800 px photo at 1.4 m/px → 1.4 × 1.12 km farm in central Iowa. */
export const FIXTURE_CAL = calibrationFromNorthAndScale({
  imageWidth: 1000,
  imageHeight: 800,
  northRotationDeg: 0,
  metersPerPixel: 1.4,
  originGeo: { lat: 41.85, lon: -93.3 },
});

export const at = (u: number, v: number): Vec => normalizedToLocal(FIXTURE_CAL, u, v);

export function fixtureFeatures(): MapFeature[] {
  return visionToFeatures(MOCK_VISION_RESULT, FIXTURE_CAL, 'mock');
}

export function fixtureProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'prop-1',
    name: 'Ridge Farm',
    stateCode: 'IA',
    calibration: FIXTURE_CAL,
    boundary: [at(0.01, 0.01), at(0.99, 0.01), at(0.99, 0.99), at(0.01, 0.99)],
    features: fixtureFeatures(),
    stands: [],
    cameras: [],
    accessConstraints: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export function weather(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    id: 'wx-1',
    at: '2026-11-07T21:00:00.000Z',
    source: 'manual',
    windFromDeg: 315,
    windSpeedMph: 9,
    windGustMph: 14,
    tempF: 38,
    cloudCoverPct: 40,
    precipChancePct: 10,
    precipType: 'none',
    pressureHpa: 1022,
    pressureTrend: 'rising',
    pressureChange3hHpa: 1.8,
    overriddenFields: [],
    ...overrides,
  };
}

export function inputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    propertyId: 'prop-1',
    date: '2026-11-07',
    window: 'PM',
    location: { lat: 41.85, lon: -93.3 },
    weather: weather(),
    weapon: { type: 'bow', effectiveRangeYds: 35 },
    ...overrides,
  };
}

export const userFeature = (id: string, type: MapFeature['type'], points: Vec[], kind: MapFeature['geometry']['kind'], extra: Partial<MapFeature> = {}): MapFeature => ({
  id,
  type,
  geometry: { kind, points },
  confidence: 1,
  source: 'user',
  status: 'active',
  ...extra,
});

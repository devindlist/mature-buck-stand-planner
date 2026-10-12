import type { Calibration, FeatureType, GeometryKind, MapFeature } from '../models.ts';
import { FEATURE_TYPES } from '../models.ts';
import { normalizedToLocal } from '../calibration/calibration.ts';

/**
 * Contract between the app, the vision proxy and the model.
 *
 * Coordinates are NORMALIZED photo coordinates: x = 0 (left) … 1 (right),
 * y = 0 (top) … 1 (bottom). The app converts them to local meters with the
 * hunter's calibration, so the model never needs to know scale or north.
 */
export interface NormPoint {
  x: number;
  y: number;
}

export interface VisionFeature {
  type: FeatureType;
  geometry_kind: GeometryKind;
  points: NormPoint[];
  confidence: number;
  label: string;
  rationale: string;
}

export type MapPhotoType = 'aerial' | 'topo' | 'hybrid' | 'app_screenshot' | 'unknown';

export interface VisionResult {
  map_type: MapPhotoType;
  north_arrow_detected: boolean;
  /** Clockwise degrees from photo-up to north; 0 when not detected. */
  north_rotation_deg: number;
  scale_bar_detected: boolean;
  /** Real-world length of the scale bar in meters; 0 when not detected. */
  scale_bar_meters: number;
  /** Two end points of the scale bar; empty when not detected. */
  scale_bar_points: NormPoint[];
  features: VisionFeature[];
  notes: string[];
}

const pointSchema = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;

/** JSON Schema used for the model's structured output (output_config.format). */
export const VISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    map_type: { type: 'string', enum: ['aerial', 'topo', 'hybrid', 'app_screenshot', 'unknown'] },
    north_arrow_detected: { type: 'boolean' },
    north_rotation_deg: { type: 'number' },
    scale_bar_detected: { type: 'boolean' },
    scale_bar_meters: { type: 'number' },
    scale_bar_points: { type: 'array', items: pointSchema },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...FEATURE_TYPES] },
          geometry_kind: { type: 'string', enum: ['point', 'line', 'polygon'] },
          points: { type: 'array', items: pointSchema },
          confidence: { type: 'number' },
          label: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['type', 'geometry_kind', 'points', 'confidence', 'label', 'rationale'],
        additionalProperties: false,
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['map_type', 'north_arrow_detected', 'north_rotation_deg', 'scale_bar_detected', 'scale_bar_meters', 'scale_bar_points', 'features', 'notes'],
  additionalProperties: false,
} as const;

const MIN_POINTS: Record<GeometryKind, number> = { point: 1, line: 2, polygon: 3 };
const MAP_TYPES: MapPhotoType[] = ['aerial', 'topo', 'hybrid', 'app_screenshot', 'unknown'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function parsePoint(v: unknown): NormPoint | null {
  if (isObj(v)) {
    const x = num(v.x);
    const y = num(v.y);
    if (x !== undefined && y !== undefined) return { x: clamp01(x), y: clamp01(y) };
  }
  if (Array.isArray(v) && v.length === 2) {
    const x = num(v[0]);
    const y = num(v[1]);
    if (x !== undefined && y !== undefined) return { x: clamp01(x), y: clamp01(y) };
  }
  return null;
}

/**
 * Defensive validation of whatever came back from the proxy/model.
 * Never throws on a bad feature: drops it and records an issue instead,
 * so one malformed detection can't sink the whole analysis.
 */
export function parseVisionResult(raw: unknown): { result: VisionResult; issues: string[] } {
  const issues: string[] = [];
  const obj = isObj(raw) ? raw : {};
  if (!isObj(raw)) issues.push('Response was not a JSON object.');
  const features: VisionFeature[] = [];
  const list = Array.isArray(obj.features) ? obj.features : [];
  list.forEach((f, i) => {
    if (!isObj(f)) return void issues.push(`Feature ${i}: not an object.`);
    const type = f.type as FeatureType;
    if (!FEATURE_TYPES.includes(type)) return void issues.push(`Feature ${i}: unknown type "${String(f.type)}".`);
    const kind = (['point', 'line', 'polygon'] as const).includes(f.geometry_kind as GeometryKind) ? (f.geometry_kind as GeometryKind) : null;
    if (!kind) return void issues.push(`Feature ${i}: bad geometry kind.`);
    const pts = (Array.isArray(f.points) ? f.points : []).map(parsePoint).filter((p): p is NormPoint => p !== null);
    if (pts.length < MIN_POINTS[kind]) return void issues.push(`Feature ${i} (${type}): needs at least ${MIN_POINTS[kind]} points.`);
    const conf = num(f.confidence);
    features.push({
      type,
      geometry_kind: kind,
      points: kind === 'point' ? [pts[0]] : pts,
      confidence: conf === undefined ? 0.5 : clamp01(conf > 1 ? conf / 100 : conf),
      label: typeof f.label === 'string' ? f.label.slice(0, 80) : type.replace(/_/g, ' '),
      rationale: typeof f.rationale === 'string' ? f.rationale.slice(0, 300) : '',
    });
  });
  const scalePts = (Array.isArray(obj.scale_bar_points) ? obj.scale_bar_points : []).map(parsePoint).filter((p): p is NormPoint => p !== null);
  const scaleMeters = num(obj.scale_bar_meters) ?? 0;
  const scaleOk = obj.scale_bar_detected === true && scaleMeters > 0 && scalePts.length === 2;
  const result: VisionResult = {
    map_type: MAP_TYPES.includes(obj.map_type as MapPhotoType) ? (obj.map_type as MapPhotoType) : 'unknown',
    north_arrow_detected: obj.north_arrow_detected === true,
    north_rotation_deg: ((num(obj.north_rotation_deg) ?? 0) % 360 + 360) % 360,
    scale_bar_detected: scaleOk,
    scale_bar_meters: scaleOk ? scaleMeters : 0,
    scale_bar_points: scaleOk ? scalePts : [],
    features,
    notes: Array.isArray(obj.notes) ? obj.notes.filter((n): n is string => typeof n === 'string').slice(0, 10) : [],
  };
  return { result, issues };
}

/** Convert validated vision output to engine features in local meters. */
export function visionToFeatures(result: VisionResult, cal: Calibration, idPrefix = 'v'): MapFeature[] {
  return result.features.map((f, i) => ({
    id: `${idPrefix}-${i}-${f.type}`,
    type: f.type,
    geometry: { kind: f.geometry_kind, points: f.points.map((p) => normalizedToLocal(cal, p.x, p.y)) },
    confidence: f.confidence,
    source: 'vision',
    status: 'active',
    label: f.label,
    rationale: f.rationale,
  }));
}

import type { Calibration, CropType, CrossCheckNote, ISODate, LatLon, MapFeature, Vec } from '../models.ts';
import { add, geometryCentroid, normalize, pointAlong, polylineLength, projectOntoPolyline, rotate, scale, sub } from '../geo/geometry.ts';
import { localToGeo } from '../geo/localFrame.ts';

/**
 * Cross-check vision detections against US public data when the photo is geo-referenced:
 *   - landforms (ridge, saddle, bench, draw, creek) against USGS 3DEP elevation
 *   - cover/field/water/timber against NLCD land cover
 *   - ag field crop against the USDA Cropland Data Layer
 * Agreement raises confidence; disagreement lowers it. Features are never deleted:
 * the hunter decides.
 */
export interface LandDataProvider {
  elevationAt(p: LatLon): Promise<number | undefined>;
  landCoverAt?(p: LatLon): Promise<number | undefined>;
  /** CDL code for the most recent published year. */
  cropAt?(p: LatLon): Promise<{ code: number; year: number } | undefined>;
}

const AGREE = 0.15;
const DISAGREE = -0.25;
const MIN_RELIEF_M = 1.5;

type Elev = (v: Vec) => Promise<number | undefined>;

async function crossProfile(elev: Elev, p: Vec, dir: Vec, offsetM: number): Promise<{ center: number; a: number; b: number } | null> {
  const [center, a, b] = await Promise.all([elev(p), elev(add(p, scale(dir, offsetM))), elev(add(p, scale(dir, -offsetM)))]);
  if (center === undefined || a === undefined || b === undefined) return null;
  return { center, a, b };
}

/** Ridge/draw: compare the line against points either side, perpendicular to it. */
async function checkLinearLandform(f: MapFeature, elev: Elev, high: boolean): Promise<CrossCheckNote> {
  const L = polylineLength(f.geometry.points);
  let agree = 0;
  let total = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const { point, tangent } = pointAlong(f.geometry.points, L * t);
    const prof = await crossProfile(elev, point, rotate(tangent, 90), 60);
    if (!prof) continue;
    total++;
    const ok = high ? prof.center - Math.max(prof.a, prof.b) >= -0.5 && prof.center - Math.min(prof.a, prof.b) >= MIN_RELIEF_M : Math.min(prof.a, prof.b) - prof.center >= -0.5 && Math.max(prof.a, prof.b) - prof.center >= MIN_RELIEF_M;
    if (ok) agree++;
  }
  if (total === 0) return { source: '3DEP', agrees: null, detail: 'No elevation coverage.', confidenceDelta: 0 };
  const agrees = agree / total >= 0.6;
  return {
    source: '3DEP',
    agrees,
    detail: agrees ? `Elevation confirms a ${high ? 'crest' : 'low line'} (${agree}/${total} profiles).` : `Elevation doesn't show a ${high ? 'crest' : 'low line'} here (${agree}/${total} profiles).`,
    confidenceDelta: agrees ? AGREE : DISAGREE,
  };
}

async function checkSaddle(f: MapFeature, elev: Elev, ridges: MapFeature[]): Promise<CrossCheckNote> {
  const p = f.geometry.points[0];
  let along: Vec = { x: 1, y: 0 };
  let bestD = Infinity;
  for (const r of ridges) {
    const proj = projectOntoPolyline(p, r.geometry.points);
    if (proj.distance < bestD) {
      bestD = proj.distance;
      along = proj.tangent;
    }
  }
  // Without a mapped ridge, try both axes and accept whichever reads as a saddle.
  const axes = bestD < 150 ? [along] : [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  for (const ax of axes) {
    const ridgeProf = await crossProfile(elev, p, normalize(ax), 80);
    const crossProf = await crossProfile(elev, p, rotate(normalize(ax), 90), 80);
    if (!ridgeProf || !crossProf) return { source: '3DEP', agrees: null, detail: 'No elevation coverage.', confidenceDelta: 0 };
    const higherAlong = Math.min(ridgeProf.a, ridgeProf.b) - ridgeProf.center >= MIN_RELIEF_M;
    const lowerAcross = crossProf.center - Math.max(crossProf.a, crossProf.b) >= MIN_RELIEF_M;
    if (higherAlong && lowerAcross) return { source: '3DEP', agrees: true, detail: 'Elevation confirms a saddle: higher along the ridge, lower to each side.', confidenceDelta: AGREE };
  }
  return { source: '3DEP', agrees: false, detail: "Elevation doesn't show a saddle shape here.", confidenceDelta: DISAGREE };
}

async function checkBench(f: MapFeature, elev: Elev): Promise<CrossCheckNote> {
  const L = polylineLength(f.geometry.points);
  const { point, tangent } = pointAlong(f.geometry.points, L / 2);
  const perp = rotate(tangent, 90);
  const near = await crossProfile(elev, point, perp, 15);
  const far = await crossProfile(elev, point, perp, 55);
  if (!near || !far) return { source: '3DEP', agrees: null, detail: 'No elevation coverage.', confidenceDelta: 0 };
  const flatSlope = Math.abs(near.a - near.b) / 30;
  const outerSlope = (Math.abs(far.a - near.a) + Math.abs(near.b - far.b)) / 80;
  const agrees = outerSlope > 0.08 && flatSlope < outerSlope * 0.5;
  return {
    source: '3DEP',
    agrees,
    detail: agrees ? `Elevation shows a flat shelf (${Math.round(flatSlope * 100)}% vs ${Math.round(outerSlope * 100)}% around it).` : 'Elevation shows no clear shelf here.',
    confidenceDelta: agrees ? AGREE : DISAGREE,
  };
}

const FOREST = new Set([41, 42, 43]);
const COVER_OK = new Set([41, 42, 43, 52, 71, 90, 95]);
const DEVELOPED = new Set([21, 22, 23, 24]);

export function nlcdCheck(type: MapFeature['type'], code: number): CrossCheckNote | null {
  const note = (agrees: boolean, detail: string): CrossCheckNote => ({ source: 'NLCD', agrees, detail, confidenceDelta: agrees ? AGREE * 0.7 : DISAGREE * 0.6 });
  switch (type) {
    case 'thick_cover':
      if (COVER_OK.has(code)) return note(true, 'Land cover agrees: forest, shrub, grass or wetland.');
      if (code === 82 || code === 11 || DEVELOPED.has(code)) return note(false, `Land cover says ${code === 82 ? 'cropland' : code === 11 ? 'water' : 'developed'}.`);
      return null;
    case 'ag_field':
    case 'food_plot':
      if (code === 81 || code === 82) return note(true, 'Land cover agrees: crop or hay.');
      if (FOREST.has(code) || code === 11) return note(type === 'food_plot', type === 'food_plot' ? 'Inside forest, typical for a hidden plot.' : 'Land cover says forest or water.');
      return null;
    case 'mast_timber':
      if (code === 41 || code === 43) return note(true, 'Land cover agrees: deciduous or mixed forest.');
      if (code === 81 || code === 82 || code === 11) return note(false, 'Land cover says field or water.');
      return null;
    case 'water':
      return note(code === 11, code === 11 ? 'Land cover agrees: open water.' : 'Land cover shows no open water.');
    default:
      return null;
  }
}

/**
 * CDL is published for the PREVIOUS season. Midwest ground is usually in a
 * corn–soybean rotation, so last year's corn suggests beans this year and vice versa.
 *
 * Only the crop FAMILY ('corn' / 'soybeans') is returned for row crops. The result is
 * stored on the feature at calibration time, so a growth stage guessed from that day
 * (green beans in September) would be frozen for the whole season. The family lets
 * food value follow the season phase at plan time instead.
 */
export function cropFromCdl(code: number, cdlYear: number, date: ISODate): { crop: CropType; detail: string } | null {
  const year = Number(date.slice(0, 4));
  const rotated = cdlYear < year;
  let base: 'corn' | 'soy' | null = code === 1 ? 'corn' : code === 5 || code === 26 ? 'soy' : null;
  if (base && rotated) base = base === 'corn' ? 'soy' : 'corn';
  const stage = 'Growth stage is estimated from the hunt date.';
  if (base === 'soy') return { crop: 'soybeans', detail: `${rotated ? `CDL ${cdlYear} showed corn. Rotation suggests beans this year.` : 'CDL shows soybeans.'} ${stage}` };
  if (base === 'corn') return { crop: 'corn', detail: `${rotated ? `CDL ${cdlYear} showed soybeans. Rotation suggests corn this year.` : 'CDL shows corn.'} ${stage}` };
  if (code === 36 || code === 37) return { crop: 'alfalfa_clover', detail: 'CDL shows alfalfa/hay.' };
  if (code === 24) return { crop: 'winter_wheat', detail: 'CDL shows winter wheat.' };
  return null;
}

export async function crossCheckFeatures(features: MapFeature[], cal: Calibration, provider: LandDataProvider, date: ISODate): Promise<MapFeature[]> {
  if (!cal.originGeo) return features;
  const origin = cal.originGeo;
  const cache = new Map<string, Promise<number | undefined>>();
  const elev: Elev = (v) => {
    const key = `${Math.round(v.x / 5)}:${Math.round(v.y / 5)}`;
    if (!cache.has(key)) cache.set(key, provider.elevationAt(localToGeo(v, origin)).catch(() => undefined));
    return cache.get(key) as Promise<number | undefined>;
  };
  const ridges = features.filter((f) => f.type === 'ridge' && f.status === 'active');
  const out: MapFeature[] = [];
  for (const f of features) {
    if (f.source === 'user' || f.status !== 'active') {
      out.push(f);
      continue;
    }
    const notes: CrossCheckNote[] = [];
    try {
      if (f.type === 'ridge' && f.geometry.points.length >= 2) notes.push(await checkLinearLandform(f, elev, true));
      if ((f.type === 'draw' || f.type === 'creek') && f.geometry.points.length >= 2) notes.push(await checkLinearLandform(f, elev, false));
      if (f.type === 'saddle') notes.push(await checkSaddle(f, elev, ridges));
      if (f.type === 'bench' && f.geometry.points.length >= 2) notes.push(await checkBench(f, elev));
      const c = localToGeo(geometryCentroid(f.geometry), origin);
      if (provider.landCoverAt && ['thick_cover', 'ag_field', 'food_plot', 'mast_timber', 'water'].includes(f.type)) {
        const code = await provider.landCoverAt(c);
        const n = code === undefined ? null : nlcdCheck(f.type, code);
        if (n) notes.push(n);
      }
      let crop = f.attributes?.crop;
      if (provider.cropAt && f.type === 'ag_field' && (!crop || crop === 'unknown')) {
        const r = await provider.cropAt(c);
        const guess = r ? cropFromCdl(r.code, r.year, date) : null;
        if (guess) {
          crop = guess.crop;
          notes.push({ source: 'CDL', agrees: null, detail: `${guess.detail} Confirm the crop.`, confidenceDelta: 0 });
        }
      }
      const delta = notes.reduce((s, n) => s + n.confidenceDelta, 0);
      out.push({
        ...f,
        confidence: Math.max(0.05, Math.min(0.98, f.confidence + delta)),
        attributes: { ...f.attributes, ...(crop ? { crop } : {}), crossCheck: notes },
      });
    } catch {
      out.push(f);
    }
  }
  return out;
}

/** Sample a regular elevation grid for thermals (fed to GridTerrain). */
export async function sampleElevationGrid(
  provider: LandDataProvider,
  originGeo: LatLon,
  center: Vec,
  halfSizeM: number,
  cellM: number,
): Promise<{ origin: Vec; cellM: number; cols: number; rows: number; values: number[] }> {
  const n = Math.max(2, Math.round((2 * halfSizeM) / cellM) + 1);
  const origin = sub(center, { x: halfSizeM, y: halfSizeM });
  const values: number[] = [];
  for (let r = 0; r < n; r++) {
    const row = await Promise.all(
      Array.from({ length: n }, (_, c) => provider.elevationAt(localToGeo(add(origin, { x: c * cellM, y: r * cellM }), originGeo)).catch(() => undefined)),
    );
    for (const v of row) values.push(v ?? NaN);
  }
  return { origin, cellM, cols: n, rows: n, values };
}


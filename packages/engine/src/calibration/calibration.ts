import type { Calibration, LatLon, PixelPoint, ReferencePoint, Vec } from '../models.ts';
import { angleDiff, bearingTo, dist, len, normDeg, rotate } from '../geo/geometry.ts';
import { geoToLocal, isInUS, localToGeo } from '../geo/localFrame.ts';

/**
 * Map-photo calibration.
 *
 * The hunter calibrates in three quick steps:
 *   1. North — rotate the on-screen arrow to the map's north (defaults to north-up,
 *      which is right for onX / HuntStand / Google screenshots).
 *   2. Scale — tap both ends of the map's scale bar (or any known distance) and type it.
 *   3. Two reference points — tap two spots and give their coordinates
 *      (stand at GPS, typed lat/lon, or a gate/corner picked on the basemap).
 *
 * Two geo-referenced points fully determine rotation, scale and position, so when
 * they exist they win, and steps 1–2 become a cross-check that catches mistakes.
 */

export interface NorthScaleInput {
  imageWidth: number;
  imageHeight: number;
  northRotationDeg: number;
  metersPerPixel: number;
  originPixel?: PixelPoint;
  originGeo?: LatLon;
  referencePoints?: ReferencePoint[];
}

export function calibrationFromNorthAndScale(input: NorthScaleInput): Calibration {
  if (!(input.metersPerPixel > 0)) throw new Error('Scale must be greater than zero.');
  const warnings: string[] = [];
  if (input.originGeo && !isInUS(input.originGeo)) warnings.push('Reference coordinates are outside the US. US data sources will not be available.');
  return {
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    northRotationDeg: normDeg(input.northRotationDeg),
    metersPerPixel: input.metersPerPixel,
    originPixel: input.originPixel ?? { x: input.imageWidth / 2, y: input.imageHeight / 2 },
    originGeo: input.originGeo,
    referencePoints: input.referencePoints ?? [],
    method: 'north_and_scale',
    warnings,
  };
}

/** Meters-per-pixel from two tapped points a known distance apart (e.g. a scale bar). */
export function scaleFromKnownDistance(a: PixelPoint, b: PixelPoint, meters: number): number {
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (px < 10) throw new Error('Tap points farther apart to set the scale.');
  if (!(meters > 0)) throw new Error('Enter the real-world distance.');
  return meters / px;
}

export const FEET_PER_METER = 3.28084;
export const METERS_PER_MILE = 1609.344;

export interface TwoPointInput {
  imageWidth: number;
  imageHeight: number;
  refs: [ReferencePoint, ReferencePoint];
  /** Hunter's step-1/step-2 estimates, used only to cross-check. */
  estimatedNorthDeg?: number;
  estimatedMetersPerPixel?: number;
}

/** Image vector (pixels, y down) expressed as a compass-style vector (y up). */
const imageUp = (from: PixelPoint, to: PixelPoint): Vec => ({ x: to.x - from.x, y: -(to.y - from.y) });

export function calibrationFromTwoPoints(input: TwoPointInput): Calibration {
  const [r1, r2] = input.refs;
  if (!r1.geo || !r2.geo) throw new Error('Both reference points need coordinates.');
  const pix = imageUp(r1.pixel, r2.pixel);
  const pixLen = len(pix);
  if (pixLen < 40) throw new Error('Reference points are too close together on the photo. Pick two spots far apart.');
  const ground = geoToLocal(r2.geo, r1.geo);
  const groundLen = len(ground);
  if (groundLen < 1) throw new Error('Reference points have the same coordinates.');

  const metersPerPixel = groundLen / pixLen;
  const northRotationDeg = normDeg(bearingTo({ x: 0, y: 0 }, pix) - bearingTo({ x: 0, y: 0 }, ground));
  const warnings: string[] = [];
  if (groundLen < 75) warnings.push('Reference points are less than 75 m apart, so rotation and scale may be imprecise.');
  if (!isInUS(r1.geo)) warnings.push('Reference coordinates are outside the US. US data sources will not be available.');
  if (input.estimatedNorthDeg !== undefined && angleDiff(input.estimatedNorthDeg, northRotationDeg) > 10) {
    warnings.push(
      `North from your reference points (${Math.round(northRotationDeg)}°) differs from the arrow you set (${Math.round(input.estimatedNorthDeg)}°). Check that both points are tapped in the right spots.`,
    );
  }
  if (input.estimatedMetersPerPixel !== undefined) {
    const ratio = metersPerPixel / input.estimatedMetersPerPixel;
    if (ratio < 0.85 || ratio > 1.15) {
      warnings.push(`Scale from your reference points differs from the scale bar by ${Math.round(Math.abs(ratio - 1) * 100)}%. Re-check the scale bar or the points.`);
    }
  }
  return {
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    northRotationDeg,
    metersPerPixel,
    originPixel: r1.pixel,
    originGeo: r1.geo,
    referencePoints: [r1, r2],
    method: 'two_point_geo',
    warnings,
  };
}

export function pixelToLocal(cal: Calibration, p: PixelPoint): Vec {
  const v = rotate(imageUp(cal.originPixel, p), -cal.northRotationDeg);
  return { x: v.x * cal.metersPerPixel, y: v.y * cal.metersPerPixel };
}

export function localToPixel(cal: Calibration, v: Vec): PixelPoint {
  const u = rotate({ x: v.x / cal.metersPerPixel, y: v.y / cal.metersPerPixel }, cal.northRotationDeg);
  return { x: cal.originPixel.x + u.x, y: cal.originPixel.y - u.y };
}

export function pixelToGeo(cal: Calibration, p: PixelPoint): LatLon | undefined {
  return cal.originGeo ? localToGeo(pixelToLocal(cal, p), cal.originGeo) : undefined;
}

export function geoToPixel(cal: Calibration, g: LatLon): PixelPoint | undefined {
  return cal.originGeo ? localToPixel(cal, geoToLocal(g, cal.originGeo)) : undefined;
}

/** Normalized (0..1) photo coordinates → local meters. Vision results use normalized coordinates. */
export function normalizedToLocal(cal: Calibration, u: number, v: number): Vec {
  return pixelToLocal(cal, { x: u * cal.imageWidth, y: v * cal.imageHeight });
}

/**
 * Lat/lon of the photo's corners in MapLibre ImageSource order:
 * top-left, top-right, bottom-right, bottom-left.
 */
export function imageCornersGeo(cal: Calibration): [LatLon, LatLon, LatLon, LatLon] | undefined {
  if (!cal.originGeo) return undefined;
  const w = cal.imageWidth;
  const h = cal.imageHeight;
  const c = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => pixelToGeo(cal, p) as LatLon);
  return [c[0], c[1], c[2], c[3]];
}

/** Ground footprint of the photo (meters), useful for sanity checks in the UI. */
export function photoFootprintM(cal: Calibration): { widthM: number; heightM: number } {
  return { widthM: cal.imageWidth * cal.metersPerPixel, heightM: cal.imageHeight * cal.metersPerPixel };
}

/** Round-trip residual for each reference point, in meters. Near zero for a consistent calibration. */
export function referenceResiduals(cal: Calibration): number[] {
  if (!cal.originGeo) return [];
  return cal.referencePoints
    .filter((r) => r.geo)
    .map((r) => dist(pixelToLocal(cal, r.pixel), geoToLocal(r.geo as LatLon, cal.originGeo as LatLon)));
}

export function describeScale(cal: Calibration): string {
  const ftPerPx = cal.metersPerPixel * FEET_PER_METER;
  const footprint = photoFootprintM(cal);
  return `${ftPerPx.toFixed(1)} ft per pixel · photo covers ${(footprint.widthM / METERS_PER_MILE).toFixed(2)} × ${(footprint.heightM / METERS_PER_MILE).toFixed(2)} mi`;
}

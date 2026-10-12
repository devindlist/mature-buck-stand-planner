import type { LatLon, Vec } from '../models.ts';
import { DEG } from './geometry.ts';

/**
 * Local tangent-plane conversion (equirectangular around an origin).
 * Error is well under 1 m across a few kilometers — ample for a hunting property.
 */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;

export function geoToLocal(p: LatLon, origin: LatLon): Vec {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LON_EQ * Math.cos(origin.lat * DEG),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

export function localToGeo(v: Vec, origin: LatLon): LatLon {
  return {
    lat: origin.lat + v.y / M_PER_DEG_LAT,
    lon: origin.lon + v.x / (M_PER_DEG_LON_EQ * Math.cos(origin.lat * DEG)),
  };
}

/** True if the coordinate is within the US (CONUS, Alaska, Hawaii) bounding boxes. */
export function isInUS(p: LatLon): boolean {
  const conus = p.lat >= 24.3 && p.lat <= 49.5 && p.lon >= -125 && p.lon <= -66.8;
  const alaska = p.lat >= 51 && p.lat <= 71.6 && p.lon >= -180 && p.lon <= -129;
  const hawaii = p.lat >= 18.8 && p.lat <= 22.4 && p.lon >= -160.5 && p.lon <= -154.7;
  return conus || alaska || hawaii;
}

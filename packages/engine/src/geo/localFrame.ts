import type { LatLon, Vec } from '../models.ts';
import { DEG } from './geometry.ts';

/**
 * Local tangent-plane conversion (equirectangular around an origin).
 * Meters per degree are evaluated at the origin latitude on the WGS84 ellipsoid
 * (meridional and prime-vertical arc lengths), so the frame is not squashed N-S.
 * What remains is the flat-frame error (longitude scale drifting with latitude away
 * from the origin): about a meter at 3 km from the origin, ample for a hunting property.
 */
export function metersPerDegree(latDeg: number): { lat: number; lon: number } {
  const phi = latDeg * DEG;
  return {
    lat: 111_132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    lon: 111_412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi),
  };
}

export function geoToLocal(p: LatLon, origin: LatLon): Vec {
  const m = metersPerDegree(origin.lat);
  return {
    x: (p.lon - origin.lon) * m.lon,
    y: (p.lat - origin.lat) * m.lat,
  };
}

export function localToGeo(v: Vec, origin: LatLon): LatLon {
  const m = metersPerDegree(origin.lat);
  return {
    lat: origin.lat + v.y / m.lat,
    lon: origin.lon + v.x / m.lon,
  };
}

/** True if the coordinate is within the US (CONUS, Alaska, Hawaii) bounding boxes. */
export function isInUS(p: LatLon): boolean {
  const conus = p.lat >= 24.3 && p.lat <= 49.5 && p.lon >= -125 && p.lon <= -66.8;
  const alaska = p.lat >= 51 && p.lat <= 71.6 && p.lon >= -180 && p.lon <= -129;
  const hawaii = p.lat >= 18.8 && p.lat <= 22.4 && p.lon >= -160.5 && p.lon <= -154.7;
  return conus || alaska || hawaii;
}

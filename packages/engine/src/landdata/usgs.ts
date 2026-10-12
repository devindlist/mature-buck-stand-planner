import type { LatLon } from '../models.ts';
import { DEG } from '../geo/geometry.ts';

/**
 * US public land-data clients. All take an injectable fetch so they run in the app,
 * in tests, and in Node. Results are cached by the app in SQLite for offline use.
 *
 *  - USGS 3DEP elevation via the Elevation Point Query Service (EPQS).
 *  - NLCD land cover via MRLC GeoServer WMS GetFeatureInfo.
 *  - USDA NASS Cropland Data Layer via CropScape GetCDLValue (EPSG:5070 coordinates).
 */

export type FetchFn = typeof fetch;

export const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
export const NLCD_WMS_URL = 'https://www.mrlc.gov/geoserver/mrlc_display/wms';
export const NLCD_LAYER = 'NLCD_2021_Land_Cover_L48';
export const CDL_URL = 'https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLValue';

export async function fetchElevationM(p: LatLon, fetchFn: FetchFn = fetch): Promise<number | undefined> {
  const url = `${EPQS_URL}?x=${p.lon.toFixed(6)}&y=${p.lat.toFixed(6)}&wkid=4326&units=Meters&includeDate=false`;
  const res = await fetchFn(url);
  if (!res.ok) return undefined;
  return parseEpqs(await res.json());
}

export function parseEpqs(body: unknown): number | undefined {
  const v = (body as { value?: unknown } | null)?.value;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  // EPQS returns -1000000 for no data.
  return Number.isFinite(n) && n > -10000 ? n : undefined;
}

export async function fetchNlcdClass(p: LatLon, fetchFn: FetchFn = fetch, layer = NLCD_LAYER): Promise<number | undefined> {
  const d = 0.0005;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetFeatureInfo',
    layers: layer,
    query_layers: layer,
    info_format: 'application/json',
    srs: 'EPSG:4326',
    bbox: `${p.lon - d},${p.lat - d},${p.lon + d},${p.lat + d}`,
    width: '3',
    height: '3',
    x: '1',
    y: '1',
  });
  const res = await fetchFn(`${NLCD_WMS_URL}?${params.toString()}`);
  if (!res.ok) return undefined;
  return parseNlcdFeatureInfo(await res.json());
}

export function parseNlcdFeatureInfo(body: unknown): number | undefined {
  const props = (body as { features?: Array<{ properties?: Record<string, unknown> }> } | null)?.features?.[0]?.properties;
  if (!props) return undefined;
  for (const key of ['PALETTE_INDEX', 'GRAY_INDEX', 'value', 'Value']) {
    const v = Number(props[key]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

export async function fetchCdlCode(p: LatLon, year: number, fetchFn: FetchFn = fetch): Promise<number | undefined> {
  const { x, y } = toConusAlbers(p);
  const res = await fetchFn(`${CDL_URL}?year=${year}&x=${x.toFixed(1)}&y=${y.toFixed(1)}`);
  if (!res.ok) return undefined;
  return parseCdlValue(await res.text());
}

/** CropScape responds with an XML wrapper around a loose JSON-ish object: `{..., value: 5, category: "Soybeans", ...}`. */
export function parseCdlValue(body: string): number | undefined {
  const m = /value"?\s*:\s*"?(\d+)/.exec(body);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// NAD83 / CONUS Albers Equal Area (EPSG:5070), ellipsoidal (Snyder 1987, eqs 14-3..14-6, 3-12)
// ---------------------------------------------------------------------------
const A = 6378137.0; // GRS80
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);

function qFn(phi: number): number {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}
const mFn = (phi: number): number => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);

const PHI1 = 29.5 * DEG;
const PHI2 = 45.5 * DEG;
const PHI0 = 23.0 * DEG;
const LAM0 = -96.0 * DEG;
const M1 = mFn(PHI1);
const M2 = mFn(PHI2);
const Q1 = qFn(PHI1);
const Q2 = qFn(PHI2);
const Q0 = qFn(PHI0);
const N = (M1 * M1 - M2 * M2) / (Q2 - Q1);
const C = M1 * M1 + N * Q1;
const RHO0 = (A * Math.sqrt(C - N * Q0)) / N;

export function toConusAlbers(p: LatLon): { x: number; y: number } {
  const q = qFn(p.lat * DEG);
  const rho = (A * Math.sqrt(C - N * q)) / N;
  const theta = N * (p.lon * DEG - LAM0);
  return { x: rho * Math.sin(theta), y: RHO0 - rho * Math.cos(theta) };
}

// ---------------------------------------------------------------------------
// Class tables
// ---------------------------------------------------------------------------

export const NLCD_CLASSES: Record<number, string> = {
  11: 'Open water',
  21: 'Developed, open space',
  22: 'Developed, low intensity',
  23: 'Developed, medium intensity',
  24: 'Developed, high intensity',
  31: 'Barren',
  41: 'Deciduous forest',
  42: 'Evergreen forest',
  43: 'Mixed forest',
  52: 'Shrub/scrub',
  71: 'Grassland',
  81: 'Pasture/hay',
  82: 'Cultivated crops',
  90: 'Woody wetlands',
  95: 'Emergent herbaceous wetlands',
};

export const CDL_CLASSES: Record<number, string> = {
  1: 'Corn',
  5: 'Soybeans',
  24: 'Winter wheat',
  26: 'Double crop winter wheat/soybeans',
  36: 'Alfalfa',
  37: 'Other hay',
  61: 'Fallow/idle cropland',
  176: 'Grassland/pasture',
  141: 'Deciduous forest',
  142: 'Evergreen forest',
  143: 'Mixed forest',
  190: 'Woody wetlands',
  111: 'Open water',
};

import { landdata, GridTerrain, sampleElevationGrid, type LandDataProvider, type LatLon, type Property, type TerrainModel, boundsOf } from '@msp/engine';
import { cacheGet, cacheSet } from '../db/repos';

/**
 * Cached USGS 3DEP / NLCD / USDA CDL provider. Land data barely changes, so cache
 * for a year: after the first online plan, cross-checks and thermals work offline.
 */
const YEAR_MS = 365 * 24 * 3_600_000;
const k = (kind: string, p: LatLon) => `${kind}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function cached<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
  const hit = await cacheGet<{ v: T | null }>(key, YEAR_MS);
  if (hit) return hit.v ?? undefined;
  const v = await load().catch(() => undefined);
  if (v !== undefined) await cacheSet(key, { v });
  return v;
}

export function createLandDataProvider(): LandDataProvider {
  // CDL is published the winter after harvest; use last year's layer.
  const cdlYear = new Date().getFullYear() - 1;
  return {
    elevationAt: (p) => cached(k('3dep', p), () => landdata.fetchElevationM(p)),
    landCoverAt: (p) => cached(k('nlcd', p), () => landdata.fetchNlcdClass(p)),
    cropAt: (p) => cached(k(`cdl${cdlYear}`, p), async () => {
      const code = await landdata.fetchCdlCode(p, cdlYear);
      return code === undefined ? undefined : { code, year: cdlYear };
    }),
  };
}

/** 3DEP elevation grid over the property for thermals (cached; ~400 points at 60 m). */
export async function loadTerrain(property: Property): Promise<TerrainModel | undefined> {
  const cal = property.calibration;
  if (!cal?.originGeo) return undefined;
  const pts = property.boundary?.length ? property.boundary : property.features.flatMap((f) => f.geometry.points);
  if (!pts.length) return undefined;
  const b = boundsOf(pts, 100);
  const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const half = Math.min(1500, Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2);
  const cell = Math.max(40, (2 * half) / 20);
  const key = `grid:${property.id}:${Math.round(center.x)}:${Math.round(center.y)}:${Math.round(half)}`;
  let grid = await cacheGet<{ origin: { x: number; y: number }; cellM: number; cols: number; rows: number; values: number[] }>(key, YEAR_MS);
  if (!grid) {
    try {
      grid = await sampleElevationGrid(createLandDataProvider(), cal.originGeo, center, half, cell);
      if (grid.values.filter((v) => Number.isFinite(v)).length < grid.values.length * 0.8) return undefined;
      await cacheSet(key, grid);
    } catch {
      return undefined;
    }
  }
  return new GridTerrain(grid.origin, grid.cellM, grid.cols, grid.rows, grid.values);
}

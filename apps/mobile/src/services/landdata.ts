import { landdata, GridTerrain, assessElevationGrid, sampleElevationGrid, type LandDataProvider, type LatLon, type Property, type TerrainModel, boundsOf } from '@msp/engine';
import { cacheGet, cacheSet, dataEpoch } from '../db/repos';

/**
 * Cached USGS 3DEP / NLCD / USDA CDL provider. Land data barely changes, so cache
 * for a year: after the first online plan, cross-checks and thermals work offline.
 */
const YEAR_MS = 365 * 24 * 3_600_000;
const k = (kind: string, p: LatLon) => `${kind}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

/**
 * Read-through cache. A lookup that fails (timeout, offline, server error) is never stored; by
 * default it reads as "no data" (`undefined`). With `rethrow` it rejects instead, so the elevation
 * grid can tell a failed request from a real gap and refuse to cache a grid full of transient holes.
 */
async function cached<T>(key: string, load: () => Promise<T | undefined>, opts: { rethrow?: boolean } = {}): Promise<T | undefined> {
  const epoch = dataEpoch();
  const hit = await cacheGet<{ v: T | null }>(key, YEAR_MS).catch(() => undefined);
  if (hit) return hit.v ?? undefined;
  let v: T | undefined;
  try {
    v = await load();
  } catch (e) {
    if (opts.rethrow) throw e;
    return undefined;
  }
  if (v !== undefined) await cacheSet(key, { v }, epoch).catch(() => undefined);
  return v;
}

export function createLandDataProvider(): LandDataProvider {
  // CDL is published the winter after harvest; use last year's layer.
  const cdlYear = new Date().getFullYear() - 1;
  return {
    elevationAt: (p) => cached(k('3dep', p), () => landdata.fetchElevationM(p), { rethrow: true }),
    landCoverAt: (p) => cached(k('nlcd', p), () => landdata.fetchNlcdClass(p)),
    cropAt: (p) => cached(k(`cdl${cdlYear}`, p), async () => {
      const code = await landdata.fetchCdlCode(p, cdlYear);
      return code === undefined ? undefined : { code, year: cdlYear };
    }),
  };
}

/** Share of grid points that must have a real 3DEP elevation before thermals use the grid. */
const MIN_GRID_COVERAGE = 0.8;

/** Cached grid as stored. JSON has no NaN: a failed sample comes back from the cache as null. */
interface ElevationGridJson {
  origin: { x: number; y: number };
  cellM: number;
  cols: number;
  rows: number;
  values: Array<number | null>;
}

/** Build the terrain model, or undefined if the grid is malformed or has too many holes. */
function toTerrain(grid: ElevationGridJson | undefined): GridTerrain | undefined {
  if (!grid || !Array.isArray(grid.values)) return undefined;
  try {
    // GridTerrain reads NaN and null alike as "no data", never as 0 m (which would fake a cliff).
    const terrain = new GridTerrain(grid.origin, grid.cellM, grid.cols, grid.rows, grid.values);
    return terrain.coverage() >= MIN_GRID_COVERAGE ? terrain : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Longest "Generate plan" waits for terrain. Past this the plan goes ahead without it (thermals fall
 * back to the mapped ridges and draws), the same as when the grid cannot be fetched at all. The
 * forecast has its own cap; the property's elevation must not be allowed to hold the spinner longer.
 */
export const TERRAIN_BUDGET_MS = 12_000;

/**
 * 3DEP elevation grid over the property for thermals (~400 points at 60 m). Never waits longer than
 * `budgetMs`. A complete grid is cached for a year; one with timed-out or failed samples is used for
 * this plan only (its good points are already cached one by one, so a retry only asks for the rest).
 */
export async function loadTerrain(property: Property, budgetMs = TERRAIN_BUDGET_MS): Promise<TerrainModel | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  try {
    return await Promise.race([loadTerrainWithin(property, budgetMs), giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadTerrainWithin(property: Property, budgetMs: number): Promise<TerrainModel | undefined> {
  const cal = property.calibration;
  if (!cal?.originGeo) return undefined;
  const pts = property.boundary?.length ? property.boundary : property.features.flatMap((f) => f.geometry.points);
  if (!pts.length) return undefined;
  const b = boundsOf(pts, 100);
  const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  const half = Math.min(1500, Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2);
  const cell = Math.max(40, (2 * half) / 20);
  const key = `grid:${property.id}:${Math.round(center.x)}:${Math.round(center.y)}:${Math.round(half)}`;
  const epoch = dataEpoch();
  // A cached grid is validated exactly like a fresh one before it is trusted offline.
  const fromCache = toTerrain(await cacheGet<ElevationGridJson>(key, YEAR_MS).catch(() => undefined));
  if (fromCache) return fromCache;
  try {
    // Stop sampling a second before the outer cap so a nearly complete grid can still be used.
    const sample = await sampleElevationGrid(createLandDataProvider(), cal.originGeo, center, half, cell, { deadlineMs: Math.max(1_000, budgetMs - 1_000) });
    const { usable, cacheable } = assessElevationGrid(sample, MIN_GRID_COVERAGE);
    if (!usable) return undefined;
    const grid: ElevationGridJson = { origin: sample.origin, cellM: sample.cellM, cols: sample.cols, rows: sample.rows, values: sample.values };
    const terrain = toTerrain(grid);
    if (terrain && cacheable) await cacheSet(key, grid, epoch).catch(() => undefined);
    return terrain;
  } catch {
    return undefined;
  }
}

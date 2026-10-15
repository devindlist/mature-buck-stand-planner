import * as FileSystem from 'expo-file-system';
import * as MapLibre from '@maplibre/maplibre-react-native';
import { boundsOf, localToGeo, type Property } from '@msp/engine';

const { OfflineManager } = MapLibre;

/**
 * USGS National Map basemaps (public domain, no API key) and offline packs.
 * Imagery+topo hybrid is the best single layer for stand planning.
 */
export const USGS_TILES = {
  imageryTopo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
  topo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  imagery: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
} as const;

export type BasemapKind = keyof typeof USGS_TILES;

export function usgsStyle(kind: BasemapKind, opacity = 1): Record<string, unknown> {
  return {
    version: 8,
    name: `USGS ${kind}`,
    sources: {
      usgs: {
        type: 'raster',
        tiles: [USGS_TILES[kind]],
        tileSize: 256,
        maxzoom: 16,
        attribution: 'USGS The National Map',
      },
    },
    layers: [{ id: 'usgs', type: 'raster', source: 'usgs', paint: { 'raster-opacity': opacity } }],
  };
}

/** [[east, north], [west, south]] in lon/lat, padded 300 m around the property. */
export function propertyBoundsLngLat(p: Property): [[number, number], [number, number]] | null {
  const origin = p.calibration?.originGeo;
  if (!origin) return null;
  const pts = p.boundary?.length ? p.boundary : p.features.flatMap((f) => f.geometry.points);
  if (!pts.length) return null;
  const b = boundsOf(pts, 300);
  const ne = localToGeo({ x: b.maxX, y: b.maxY }, origin);
  const sw = localToGeo({ x: b.minX, y: b.minY }, origin);
  return [
    [ne.lon, ne.lat],
    [sw.lon, sw.lat],
  ];
}

export const packName = (p: Property, kind: BasemapKind) => `msp-${p.id}-${kind}`;

/** Folder (under the documents directory) that holds the style files offline packs are built from. */
const STYLE_DIR = 'styles/';

/**
 * Writes the basemap style to a file and returns its file:// URL.
 *
 * MapLibre's offline downloader defines a region by a style URL: it fetches that style to
 * learn which tiles to download. maplibre-react-native's OfflineCreatePackOptions requires
 * `styleURL` (it throws "Style URL must be provided" without one) and has no option that
 * takes style JSON, so the JSON goes to a file. The map itself loads the same tile URL
 * templates, so the cached tiles are hit when there is no signal.
 */
export async function writeStyleFile(kind: BasemapKind): Promise<string> {
  const docs: string | null | undefined = FileSystem.documentDirectory;
  if (!docs) throw new Error('App storage is not available, so the offline basemap cannot be saved.');
  const dir = `${docs}${STYLE_DIR}`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}usgs-${kind}.json`;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(usgsStyle(kind)));
  return uri;
}

/** No progress event for this long means the download is stuck (no signal, app paused). */
const STALL_MS = 90_000;

interface PackStatus {
  state?: number | string;
  percentage: number;
  completedResourceCount?: number;
  requiredResourceCount?: number;
  completedTileCount?: number;
}

/** MapLibre's "download complete" state constant, when this library version exports it. */
const COMPLETE_STATE = (MapLibre as unknown as { OfflinePackDownloadState?: { Complete?: number | string } }).OfflinePackDownloadState?.Complete;

/**
 * True when a progress event says the download has finished. The library's Complete state
 * is authoritative: the percentage can read 100 early (the style alone is one finished
 * resource out of one known), long before the tiles are even listed.
 */
export function packDownloadFinished(status: PackStatus, completeState: number | string | undefined = COMPLETE_STATE): boolean {
  if (completeState !== undefined) return status.state === completeState;
  return status.percentage >= 100 && (status.completedResourceCount ?? 0) >= (status.requiredResourceCount ?? Infinity) && (status.completedTileCount ?? 0) > 0;
}

/** Downloads running right now, by pack name: a second request for the same pack joins the first. */
const downloads = new Map<string, { promise: Promise<void>; listeners: Set<(pct: number) => void> }>();

/** True while a download of this property's pack is running. */
export function isDownloadingPack(p: Property, kind: BasemapKind): boolean {
  return downloads.has(packName(p, kind));
}

/**
 * Download zooms 12–16 for the property (typically 2–15 MB for a farm).
 * Progress is reported 0..100. Resolves only when tiles were really saved; rejects with a
 * plain message on any failure (bad style, no signal, no progress for 90 s) so the caller
 * never reports "ready" for a pack that has no map in it. A pack left half-downloaded by a
 * failure is deleted.
 *
 * One download per pack at a time: asking again while it runs does NOT restart it (that
 * would delete the pack the first request is filling); the second caller just follows the
 * first one's progress and result.
 */
export function downloadOfflinePack(p: Property, kind: BasemapKind, onProgress: (pct: number) => void): Promise<void> {
  const name = packName(p, kind);
  const running = downloads.get(name);
  if (running) {
    running.listeners.add(onProgress);
    return running.promise;
  }
  const listeners = new Set<(pct: number) => void>([onProgress]);
  const promise = runDownload(p, kind, (pct) => listeners.forEach((l) => l(pct))).finally(() => downloads.delete(name));
  downloads.set(name, { promise, listeners });
  return promise;
}

async function runDownload(p: Property, kind: BasemapKind, onProgress: (pct: number) => void): Promise<void> {
  const bounds = propertyBoundsLngLat(p);
  if (!bounds) throw new Error('Geo-reference the map (two reference points) to download offline basemaps.');
  const name = packName(p, kind);
  const styleURL = await writeStyleFile(kind);
  const existing = await OfflineManager.getPack(name);
  if (existing) await OfflineManager.deletePack(name);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        try {
          OfflineManager.unsubscribe(name);
        } catch {
          /* nothing subscribed */
        }
        if (err) reject(err);
        else resolve();
      };
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(new Error('The download stopped making progress. Check your signal and try again.')), STALL_MS);
      };
      arm();
      // createPack is async: a rejected promise (bad options, native failure) must reach the caller.
      OfflineManager.createPack(
        { name, styleURL, bounds, minZoom: 12, maxZoom: 16, metadata: { propertyId: p.id } },
        (_pack: unknown, status: PackStatus) => {
          arm();
          onProgress(Number.isFinite(status.percentage) ? Math.max(0, Math.min(100, Math.round(status.percentage))) : 0);
          if (!packDownloadFinished(status)) return;
          if (!((status.completedTileCount ?? 0) > 0)) {
            finish(new Error('The download finished but saved no map tiles, so the offline basemap would be blank. Try again on a good connection.'));
            return;
          }
          finish();
        },
        (_pack: unknown, err: { message?: string }) => finish(new Error(err?.message || 'The offline map download failed.')),
      ).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  } catch (e) {
    // A failed download must not leave a partial pack registered as if it were the offline map.
    try {
      await OfflineManager.deletePack(name);
    } catch {
      /* the pack was never created */
    }
    throw e;
  }
}

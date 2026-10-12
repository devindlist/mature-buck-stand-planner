import { OfflineManager } from '@maplibre/maplibre-react-native';
import { boundsOf, localToGeo, type Property } from '@msp/engine';

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

/**
 * Download zooms 12–16 for the property (typically 2–15 MB for a farm).
 * Progress is reported 0..100.
 */
export async function downloadOfflinePack(p: Property, kind: BasemapKind, onProgress: (pct: number) => void): Promise<void> {
  const bounds = propertyBoundsLngLat(p);
  if (!bounds) throw new Error('Geo-reference the map (two reference points) to download offline basemaps.');
  const name = packName(p, kind);
  const existing = await OfflineManager.getPack(name);
  if (existing) await OfflineManager.deletePack(name);
  await new Promise<void>((resolve, reject) => {
    OfflineManager.createPack(
      { name, mapStyle: JSON.stringify(usgsStyle(kind)), bounds, minZoom: 12, maxZoom: 16, metadata: { propertyId: p.id } },
      (_pack: unknown, status: { percentage: number; state?: number | string }) => {
        onProgress(Math.round(status.percentage));
        if (status.percentage >= 100) resolve();
      },
      (_pack: unknown, err: { message: string }) => reject(new Error(err.message)),
    );
  });
}

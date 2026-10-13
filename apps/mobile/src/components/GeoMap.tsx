import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Camera, CircleLayer, FillLayer, ImageSource, LineLayer, MapView, MarkerView, RasterLayer, ShapeSource } from '@maplibre/maplibre-react-native';
import {
  add,
  bearingVec,
  circlePolygon,
  geometryCentroid,
  imageCornersGeo,
  localToGeo,
  pointAlong,
  polylineLength,
  scale as vscale,
  sectorPolygon,
  type AccessConstraint,
  type Calibration,
  type HabitatSummary,
  type LatLon,
  type MapFeature,
  type Route,
  type StandRecommendation,
  type Vec,
} from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { propertyBoundsLngLat, usgsStyle, type BasemapKind } from '../services/offlineMaps';
import { featureColor, POINT_GLYPH, type MapStand } from './PhotoMap';
import { StatusIcon } from './Icons';
import type { Property } from '@msp/engine';

/**
 * USGS basemap (MapLibre Native, works from offline packs) with the hunter's photo
 * draped on top and the same overlays as PhotoMap: habitat, the hunter's features and
 * constraints, scent plumes with wind/thermal arrows, entry/exit routes and stands.
 * Only available once the photo is geo-referenced with two reference points.
 *
 * MapLibre notes (maplibre-react-native v10, MapLibre Native 11 / iOS 6):
 *  - line-dasharray is not data-driven on native, so solid and dashed lines are separate
 *    layers with a filter and a constant dash array.
 *  - The base style has no `glyphs`, and offline packs cannot hold glyph ranges for layers
 *    that are added later, so no SymbolLayer text is used. Ranks, status icons and labels are
 *    React Native views on MarkerViews, which also keeps them readable in red-light mode.
 */
type Pos = [number, number];
type Props = Record<string, string | number>;

const MAX_POINT_MARKERS = 24;

export interface GeoMapProps {
  property: Property;
  basemap: BasemapKind;
  habitat?: HabitatSummary;
  /** Roads, houses, access points and pinch points (and any other feature) to draw. */
  features?: MapFeature[];
  constraints?: AccessConstraint[];
  stands?: MapStand[];
  routes?: Route[];
  /** Scent plumes for the selected stand: wind solid, thermals dashed. */
  plumes?: { origin: Vec; plumes: StandRecommendation['plumes'] };
  photoOpacity?: number;
  onPressStand?: (id: string) => void;
  /** A tap on the bare map (e.g. to place a moved stand), as coordinates. */
  onPressMap?: (at: LatLon) => void;
}

export function GeoMap({ property, basemap, habitat, features, constraints, stands, routes, plumes, photoOpacity = 0.55, onPressStand, onPressMap }: GeoMapProps) {
  const t = useTheme();
  const cal = property.calibration as Calibration;
  const origin = cal.originGeo!;
  const ll = (v: Vec): Pos => {
    const g = localToGeo(v, origin);
    return [g.lon, g.lat];
  };
  const bounds = propertyBoundsLngLat(property);
  const corners = imageCornersGeo(cal);
  const style = useMemo(() => JSON.stringify(usgsStyle(basemap, t.name === 'redlight' ? 0.25 : 1)), [basemap, t.name]);
  // Initial framing only: a new `bounds` object on every render would snap the camera back after each pan.
  const cameraDefaults = useMemo(
    () => (bounds ? { bounds: { ne: bounds[0], sw: bounds[1], paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20 }, animationDuration: 0 } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bounds?.[0][0], bounds?.[0][1], bounds?.[1][0], bounds?.[1][1]],
  );

  const poly = (pts: Vec[], properties: Props = {}) => ({
    type: 'Feature' as const,
    properties,
    geometry: { type: 'Polygon' as const, coordinates: [[...pts, pts[0]].map(ll)] },
  });
  const line = (pts: Vec[], properties: Props = {}) => ({
    type: 'Feature' as const,
    properties,
    geometry: { type: 'LineString' as const, coordinates: pts.map(ll) },
  });
  const collection = <F,>(features: F[]) => ({ type: 'FeatureCollection' as const, features });

  // Bedding and food: the polygon when there is one, else the circle the engine reasons with.
  const habitatGeo = useMemo(
    () =>
      collection([
        ...(habitat?.bedding ?? []).map((b) => poly(b.polygon && b.polygon.length >= 3 ? b.polygon : circlePolygon(b.center, b.radiusM), { kind: 'bedding' })),
        ...(habitat?.food ?? []).map((f) => poly(f.polygon && f.polygon.length >= 3 ? f.polygon : circlePolygon(f.center, f.radiusM), { kind: 'food' })),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habitat, origin.lat, origin.lon],
  );

  const corridorGeo = useMemo(
    () => collection((habitat?.corridors ?? []).slice(0, 8).filter((c) => c.points.length >= 2).map((c) => line(c.points, { strength: c.strength }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habitat, origin.lat, origin.lon],
  );

  // The hunter's features: areas and lines are drawn; points get a lettered marker below.
  const activeFeatures = useMemo(() => (features ?? []).filter((f) => f.status === 'active' && f.geometry.points.length > 0), [features]);
  const featureAreaGeo = useMemo(
    () => collection(activeFeatures.filter((f) => f.geometry.kind === 'polygon' && f.geometry.points.length >= 3).map((f) => poly(f.geometry.points, { color: featureColor(t, f.type) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFeatures, t, origin.lat, origin.lon],
  );
  const featureLineGeo = useMemo(
    () => collection(activeFeatures.filter((f) => f.geometry.kind === 'line' && f.geometry.points.length >= 2).map((f) => line(f.geometry.points, { color: featureColor(t, f.type) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFeatures, t, origin.lat, origin.lon],
  );
  const pointFeatures = activeFeatures.filter((f) => f.geometry.kind === 'point').slice(0, MAX_POINT_MARKERS);

  const constraintAreaGeo = useMemo(
    () => collection((constraints ?? []).filter((c) => c.geometry.kind === 'polygon' && c.geometry.points.length >= 3).map((c) => poly(c.geometry.points, { zone: c.kind === 'no_access_zone' ? 1 : 0 }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [constraints, origin.lat, origin.lon],
  );
  const constraintLineGeo = useMemo(
    () => collection((constraints ?? []).filter((c) => c.geometry.kind === 'line' && c.geometry.points.length >= 2).map((c) => line(c.geometry.points))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [constraints, origin.lat, origin.lon],
  );

  // Scent plumes: sector fills, outlines, and an arrow (shaft + head) along each plume.
  const plumeGeo = useMemo(() => {
    const sectors: ReturnType<typeof poly>[] = [];
    const shafts: ReturnType<typeof line>[] = [];
    const heads: ReturnType<typeof poly>[] = [];
    if (plumes) {
      for (const pl of plumes.plumes) {
        const len = Math.min(pl.lengthM, 300);
        const thermal = pl.kind !== 'wind' ? 1 : 0;
        sectors.push(poly(sectorPolygon(plumes.origin, pl.bearingDeg, Math.min(pl.halfAngleDeg, 179), len, 10), { thermal }));
        if (pl.kind === 'swirl') continue;
        const dir = bearingVec(pl.bearingDeg);
        const tip = add(plumes.origin, vscale(dir, len * 0.55));
        const h = Math.max(8, len * 0.09);
        const back = add(tip, vscale(dir, -h));
        const side = vscale({ x: -dir.y, y: dir.x }, h * 0.5);
        shafts.push(line([plumes.origin, back], { thermal }));
        heads.push(poly([tip, add(back, side), add(back, vscale(side, -1))], { thermal }));
      }
    }
    return { sectors: collection(sectors), shafts: collection(shafts), heads: collection(heads) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plumes, origin.lat, origin.lon]);

  const routeGeo = useMemo(
    () =>
      collection(
        (routes ?? []).flatMap((r) => r.segments.filter((s) => s.points.length >= 2).map((s) => line(s.points, { status: s.status, kind: r.kind }))),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, origin.lat, origin.lon],
  );
  const routeStartGeo = useMemo(
    () =>
      collection(
        (routes ?? [])
          .filter((r) => r.points.length > 0)
          .map((r) => ({
            type: 'Feature' as const,
            properties: { kind: r.kind },
            geometry: { type: 'Point' as const, coordinates: ll(r.kind === 'entry' ? r.points[0] : r.points[r.points.length - 1]) },
          })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, origin.lat, origin.lon],
  );

  const standGeo = useMemo(
    () =>
      collection(
        (stands ?? []).map((s) => ({
          type: 'Feature' as const,
          id: s.id,
          properties: { id: s.id, selected: s.selected ? 1 : 0 },
          geometry: { type: 'Point' as const, coordinates: ll(s.position) },
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stands, origin.lat, origin.lon],
  );

  const statusColor = (s: 'safe' | 'caution' | 'avoid') => t.status[s];

  return (
    <MapView
      style={{ flex: 1 }}
      mapStyle={style}
      attributionEnabled
      logoEnabled={false}
      compassEnabled
      onPress={
        onPressMap
          ? (f: { geometry: unknown }) => {
              // The press arrives as a GeoJSON Point feature: [lon, lat].
              const c = (f?.geometry as { coordinates?: unknown } | undefined)?.coordinates;
              if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') onPressMap({ lat: c[1], lon: c[0] });
            }
          : undefined
      }
    >
      {cameraDefaults ? <Camera defaultSettings={cameraDefaults} /> : null}
      {corners && property.mapImageUri ? (
        <ImageSource id="photo" url={property.mapImageUri} coordinates={corners.map((c) => [c.lon, c.lat]) as [Pos, Pos, Pos, Pos]}>
          <RasterLayer id="photo-layer" style={{ rasterOpacity: photoOpacity }} />
        </ImageSource>
      ) : null}

      <ShapeSource id="habitat" shape={habitatGeo}>
        <FillLayer id="habitat-fill" style={{ fillColor: ['match', ['get', 'kind'], 'bedding', t.map.bedding, t.map.food], fillOpacity: 0.3 }} />
        <LineLayer id="habitat-bedding-line" filter={['==', ['get', 'kind'], 'bedding']} style={{ lineColor: t.map.bedding, lineWidth: 2 }} />
        <LineLayer id="habitat-food-line" filter={['==', ['get', 'kind'], 'food']} style={{ lineColor: t.map.food, lineWidth: 1.5, lineDasharray: [3, 3] }} />
      </ShapeSource>
      <ShapeSource id="corridors" shape={corridorGeo}>
        <LineLayer
          id="corridors-line"
          style={{ lineColor: t.map.corridor, lineWidth: ['+', 2, ['*', 4, ['get', 'strength']]], lineOpacity: ['+', 0.35, ['*', 0.6, ['get', 'strength']]], lineDasharray: [4, 2.5] }}
        />
      </ShapeSource>

      <ShapeSource id="feature-areas" shape={featureAreaGeo}>
        <FillLayer id="feature-areas-fill" style={{ fillColor: ['get', 'color'], fillOpacity: 0.14 }} />
        <LineLayer id="feature-areas-line" style={{ lineColor: ['get', 'color'], lineWidth: 1.5 }} />
      </ShapeSource>
      <ShapeSource id="feature-lines" shape={featureLineGeo}>
        <LineLayer id="feature-lines-line" style={{ lineColor: ['get', 'color'], lineWidth: 3 }} />
      </ShapeSource>

      <ShapeSource id="constraint-areas" shape={constraintAreaGeo}>
        <FillLayer id="constraint-areas-fill" style={{ fillColor: t.status.avoid, fillOpacity: 0.14 }} />
        <LineLayer id="constraint-areas-line" style={{ lineColor: t.status.avoid, lineWidth: 2.5, lineDasharray: [3, 3] }} />
      </ShapeSource>
      <ShapeSource id="constraint-lines" shape={constraintLineGeo}>
        <LineLayer id="constraint-lines-line" style={{ lineColor: t.status.caution, lineWidth: 3, lineDasharray: [4, 2] }} />
      </ShapeSource>

      <ShapeSource id="plume-sectors" shape={plumeGeo.sectors}>
        <FillLayer id="plume-wind-fill" filter={['==', ['get', 'thermal'], 0]} style={{ fillColor: t.wind, fillOpacity: 0.12 }} />
        <FillLayer id="plume-thermal-fill" filter={['==', ['get', 'thermal'], 1]} style={{ fillColor: t.thermal, fillOpacity: 0.08 }} />
        <LineLayer id="plume-wind-edge" filter={['==', ['get', 'thermal'], 0]} style={{ lineColor: t.wind, lineOpacity: 0.5, lineWidth: 1.5 }} />
        <LineLayer id="plume-thermal-edge" filter={['==', ['get', 'thermal'], 1]} style={{ lineColor: t.thermal, lineOpacity: 0.5, lineWidth: 1.5, lineDasharray: [3, 3] }} />
      </ShapeSource>
      <ShapeSource id="plume-shafts" shape={plumeGeo.shafts}>
        <LineLayer id="plume-wind-shaft" filter={['==', ['get', 'thermal'], 0]} style={{ lineColor: t.wind, lineWidth: 3 }} />
        <LineLayer id="plume-thermal-shaft" filter={['==', ['get', 'thermal'], 1]} style={{ lineColor: t.thermal, lineWidth: 3, lineDasharray: [3, 2.5] }} />
      </ShapeSource>
      <ShapeSource id="plume-heads" shape={plumeGeo.heads}>
        <FillLayer id="plume-heads-fill" style={{ fillColor: ['match', ['get', 'thermal'], 1, t.thermal, t.wind], fillOpacity: 1 }} />
      </ShapeSource>

      {/* Entry is a solid line, exit a dashed one: two layers, because native line-dasharray cannot be data-driven. */}
      <ShapeSource id="routes" shape={routeGeo}>
        <LineLayer id="routes-entry" filter={['==', ['get', 'kind'], 'entry']} style={{ lineColor: ['match', ['get', 'status'], 'safe', t.status.safe, 'caution', t.status.caution, t.status.avoid], lineWidth: 5, lineCap: 'round', lineJoin: 'round' }} />
        <LineLayer id="routes-exit" filter={['==', ['get', 'kind'], 'exit']} style={{ lineColor: ['match', ['get', 'status'], 'safe', t.status.safe, 'caution', t.status.caution, t.status.avoid], lineWidth: 5, lineCap: 'butt', lineJoin: 'round', lineDasharray: [2, 1.5] }} />
      </ShapeSource>
      <ShapeSource id="route-starts" shape={routeStartGeo}>
        <CircleLayer
          id="route-starts-circle"
          style={{ circleRadius: 7, circleColor: ['match', ['get', 'kind'], 'entry', t.route.entry, t.route.exit], circleStrokeColor: t.bg, circleStrokeWidth: 2 }}
        />
      </ShapeSource>

      <ShapeSource
        id="stands"
        shape={standGeo}
        hitbox={{ width: 56, height: 56 }}
        onPress={(e: { features: Array<{ properties?: unknown }> }) => {
          const id = (e.features?.[0]?.properties as { id?: string } | null | undefined)?.id;
          if (id && onPressStand) onPressStand(id);
        }}
      >
        <CircleLayer
          id="stands-circle"
          style={{
            circleRadius: ['case', ['==', ['get', 'selected'], 1], 16, 13],
            circleColor: ['case', ['==', ['get', 'selected'], 1], t.map.standSelected, t.map.stand],
            circleStrokeColor: t.bg,
            circleStrokeWidth: 2,
          }}
        />
      </ShapeSource>

      {/* Point features (house, access, saddle, funnel...): a lettered badge, never colour alone. */}
      {pointFeatures.map((f) => {
        const c = featureColor(t, f.type);
        return (
          <MarkerView key={`pf-${f.id}`} coordinate={ll(f.geometry.points[0])}>
            <View pointerEvents="none" style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.bg, borderWidth: 2.5, borderColor: c, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: c, fontSize: 12, fontWeight: '900' }}>{POINT_GLYPH[f.type] ?? '•'}</Text>
            </View>
          </MarkerView>
        );
      })}
      {(constraints ?? [])
        .filter((c) => c.geometry.points.length > 0)
        .map((c) => {
          const col = c.kind === 'no_access_zone' ? t.status.avoid : t.status.caution;
          const word = c.kind === 'no_access_zone' ? 'NO ACCESS' : c.kind === 'neighbor_line' ? 'NEIGHBOR' : c.kind === 'must_use_gate' ? 'GATE' : 'RESTRICTED';
          return (
            <MarkerView key={`ct-${c.id}`} coordinate={ll(c.geometry.kind === 'point' ? c.geometry.points[0] : geometryCentroid(c.geometry))}>
              <View pointerEvents="none" style={{ backgroundColor: t.bg, borderColor: col, borderWidth: 2, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ color: col, fontSize: 10, fontWeight: '900' }}>{word}</Text>
              </View>
            </MarkerView>
          );
        })}

      {/* Status icon on every non-safe stretch of a route (caution triangle / avoid octagon). */}
      {(routes ?? []).flatMap((r) =>
        r.segments.flatMap((s, i) => {
          if (s.status === 'safe' || s.points.length < 2) return [];
          return [
            <MarkerView key={`rs-${r.kind}-${i}`} coordinate={ll(pointAlong(s.points, polylineLength(s.points) / 2).point)}>
              <View pointerEvents="none" style={{ backgroundColor: t.bg, borderRadius: 12, padding: 2 }}>
                <StatusIcon status={s.status} color={statusColor(s.status)} size={20} />
              </View>
            </MarkerView>,
          ];
        }),
      )}
      {/* IN / OUT tags at the start of each route, so entry and exit differ by more than line style. */}
      {(routes ?? [])
        .filter((r) => r.points.length > 0)
        .map((r) => {
          const col = r.kind === 'entry' ? t.route.entry : t.route.exit;
          return (
            <MarkerView key={`ri-${r.kind}`} coordinate={ll(r.kind === 'entry' ? r.points[0] : r.points[r.points.length - 1])}>
              {/* The marker is centred on the route start, so the tag sits in the top half of a taller box. */}
              <View pointerEvents="none" style={{ height: 52, alignItems: 'center', justifyContent: 'flex-start' }}>
                <View style={{ backgroundColor: t.bg, borderColor: col, borderWidth: 2, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ color: col, fontSize: 11, fontWeight: '900' }}>{r.kind === 'entry' ? 'IN' : 'OUT'}</Text>
                </View>
              </View>
            </MarkerView>
          );
        })}

      {/* Stand badges: rank (1/2/3/B/star) plus a status icon (check / ! / X). */}
      {(stands ?? []).map((s) => {
        const size = s.selected ? 36 : 30;
        const st = s.status === 'go' ? 'safe' : s.status === 'no_go' ? 'avoid' : s.status === 'caution' ? 'caution' : undefined;
        const label = s.rank ? (s.rank === 4 ? 'B' : String(s.rank)) : s.existing ? '★' : '•';
        return (
          <MarkerView key={`st-${s.id}`} coordinate={ll(s.position)} allowOverlap isSelected={!!s.selected}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${s.label}${st ? `, ${s.status === 'go' ? 'go' : s.status === 'no_go' ? 'no-go' : 'caution'}` : ''}`}
              onPress={onPressStand ? () => onPressStand(s.id) : undefined}
              // Not tappable (e.g. while a stand is being moved): let touches fall through to the map.
              pointerEvents={onPressStand ? 'auto' : 'none'}
              style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}
            >
              <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: s.selected ? t.map.standSelected : t.map.stand, borderWidth: 2, borderColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: t.accentText, fontSize: 14, fontWeight: '900' }}>{label}</Text>
              </View>
              {st ? (
                <View style={{ position: 'absolute', right: 2, top: 2, backgroundColor: t.bg, borderRadius: 11, padding: 1 }}>
                  <StatusIcon status={st} color={statusColor(st)} size={18} />
                </View>
              ) : null}
            </Pressable>
          </MarkerView>
        );
      })}
    </MapView>
  );
}

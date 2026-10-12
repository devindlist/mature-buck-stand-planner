import React, { useMemo } from 'react';
import { Camera, FillLayer, ImageSource, LineLayer, MapView, RasterLayer, ShapeSource, CircleLayer, SymbolLayer } from '@maplibre/maplibre-react-native';
import { imageCornersGeo, localToGeo, type Calibration, type HabitatSummary, type Route, type Vec } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { propertyBoundsLngLat, usgsStyle, type BasemapKind } from '../services/offlineMaps';
import type { MapStand } from './PhotoMap';
import type { Property } from '@msp/engine';

/**
 * USGS basemap (MapLibre Native, works from offline packs) with the hunter's photo
 * draped on top and the same overlays as PhotoMap. Only available once the photo is
 * geo-referenced with two reference points.
 */
export function GeoMap({
  property,
  basemap,
  habitat,
  stands,
  routes,
  photoOpacity = 0.55,
  onPressStand,
}: {
  property: Property;
  basemap: BasemapKind;
  habitat?: HabitatSummary;
  stands?: MapStand[];
  routes?: Route[];
  photoOpacity?: number;
  onPressStand?: (id: string) => void;
}) {
  const t = useTheme();
  const cal = property.calibration as Calibration;
  const origin = cal.originGeo!;
  const ll = (v: Vec): [number, number] => {
    const g = localToGeo(v, origin);
    return [g.lon, g.lat];
  };
  const bounds = propertyBoundsLngLat(property);
  const corners = imageCornersGeo(cal);
  const style = useMemo(() => JSON.stringify(usgsStyle(basemap, t.name === 'redlight' ? 0.25 : 1)), [basemap, t.name]);

  const habitatGeo = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: [
        ...(habitat?.bedding ?? [])
          .filter((b) => b.polygon)
          .map((b) => ({ type: 'Feature' as const, properties: { kind: 'bedding' }, geometry: { type: 'Polygon' as const, coordinates: [[...b.polygon!, b.polygon![0]].map(ll)] } })),
        ...(habitat?.food ?? [])
          .filter((f) => f.polygon)
          .map((f) => ({ type: 'Feature' as const, properties: { kind: 'food' }, geometry: { type: 'Polygon' as const, coordinates: [[...f.polygon!, f.polygon![0]].map(ll)] } })),
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [habitat, origin.lat, origin.lon],
  );

  const routeGeo = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: (routes ?? []).flatMap((r) =>
        r.segments.map((s) => ({ type: 'Feature' as const, properties: { status: s.status, kind: r.kind }, geometry: { type: 'LineString' as const, coordinates: s.points.map(ll) } })),
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, origin.lat, origin.lon],
  );

  const standGeo = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: (stands ?? []).map((s) => ({
        type: 'Feature' as const,
        id: s.id,
        properties: { id: s.id, label: s.rank ? (s.rank === 4 ? 'B' : String(s.rank)) : '★', selected: s.selected ? 1 : 0 },
        geometry: { type: 'Point' as const, coordinates: ll(s.position) },
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stands, origin.lat, origin.lon],
  );

  return (
    <MapView style={{ flex: 1 }} mapStyle={style} attributionEnabled logoEnabled={false} compassEnabled>
      {bounds ? <Camera bounds={{ ne: bounds[0], sw: bounds[1], paddingTop: 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20 }} animationDuration={0} /> : null}
      {corners && property.mapImageUri ? (
        <ImageSource id="photo" url={property.mapImageUri} coordinates={corners.map((c) => [c.lon, c.lat]) as [[number, number], [number, number], [number, number], [number, number]]}>
          <RasterLayer id="photo-layer" style={{ rasterOpacity: photoOpacity }} />
        </ImageSource>
      ) : null}
      <ShapeSource id="habitat" shape={habitatGeo}>
        <FillLayer id="habitat-fill" style={{ fillColor: ['match', ['get', 'kind'], 'bedding', t.map.bedding, t.map.food], fillOpacity: 0.3 }} />
      </ShapeSource>
      <ShapeSource id="routes" shape={routeGeo}>
        <LineLayer
          id="routes-line"
          style={{
            lineColor: ['match', ['get', 'status'], 'safe', t.status.safe, 'caution', t.status.caution, t.status.avoid],
            lineWidth: 5,
            lineDasharray: ['case', ['==', ['get', 'kind'], 'exit'], ['literal', [2, 1.5]], ['literal', [1, 0]]],
          }}
        />
      </ShapeSource>
      <ShapeSource id="stands" shape={standGeo} onPress={(e: { features?: Array<{ properties?: { id?: string } }> }) => {
        const id = e.features?.[0]?.properties?.id;
        if (id && onPressStand) onPressStand(id);
      }}>
        <CircleLayer id="stands-circle" style={{ circleRadius: ['case', ['==', ['get', 'selected'], 1], 16, 13], circleColor: ['case', ['==', ['get', 'selected'], 1], t.map.standSelected, t.map.stand], circleStrokeColor: t.bg, circleStrokeWidth: 2 }} />
        <SymbolLayer id="stands-label" style={{ textField: ['get', 'label'], textSize: 14, textColor: t.accentText, textAllowOverlap: true }} />
      </ShapeSource>
    </MapView>
  );
}

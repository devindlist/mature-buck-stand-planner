import React, { useMemo } from 'react';
import { Image, Pressable, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import {
  add,
  bearingVec,
  localToPixel,
  scale as vscale,
  sectorPolygon,
  type Calibration,
  type FeatureType,
  type HabitatSummary,
  type MapFeature,
  type PixelPoint,
  type Route,
  type StandRecommendation,
  type Vec,
} from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/theme';

/**
 * The calibrated photo with everything drawn on top, in SVG. Works fully offline and
 * without geo-reference, so it is the default map everywhere. All overlay geometry is
 * in local meters and projected back onto the photo through the hunter's calibration.
 */

export interface MapStand {
  id: string;
  position: Vec;
  label: string;
  rank?: number;
  selected?: boolean;
  status?: 'go' | 'caution' | 'no_go';
  existing?: boolean;
}

export interface PhotoMapProps {
  imageUri: string;
  calibration: Calibration;
  width: number;
  maxHeight?: number;
  features?: MapFeature[];
  habitat?: HabitatSummary;
  stands?: MapStand[];
  routes?: Route[];
  plumes?: { origin: Vec; plumes: StandRecommendation['plumes'] };
  /** Raw photo pixels (calibration taps), drawn as numbered pins. */
  pins?: Array<{ pixel: PixelPoint; label: string }>;
  selectedFeatureId?: string | null;
  showDismissed?: boolean;
  onPressPixel?: (p: PixelPoint) => void;
  onPressStand?: (id: string) => void;
  onPressFeature?: (id: string) => void;
}

export function featureColor(t: Theme, type: FeatureType): string {
  switch (type) {
    case 'thick_cover':
    case 'bedding':
      return t.map.bedding;
    case 'ag_field':
    case 'food_plot':
      return t.map.food;
    case 'mast_timber':
      return t.name === 'redlight' ? t.textDim : '#8DBF5A';
    case 'water':
    case 'creek':
    case 'creek_crossing':
      return t.name === 'redlight' ? t.textDim : '#5AB4E8';
    case 'road':
    case 'house':
      return t.name === 'redlight' ? t.text : '#D9D9D9';
    case 'ridge':
    case 'saddle':
    case 'bench':
    case 'draw':
      return t.name === 'redlight' ? t.textDim : '#E2B97F';
    case 'access_point':
      return t.route.entry;
    default:
      return t.map.corridor;
  }
}

const POINT_GLYPH: Partial<Record<FeatureType, string>> = {
  saddle: 'S',
  funnel: 'F',
  creek_crossing: 'X',
  inside_corner: 'C',
  house: 'H',
  access_point: 'P',
  bedding: 'B',
};

export function PhotoMap(props: PhotoMapProps) {
  const t = useTheme();
  const { calibration: cal, width } = props;
  const k = Math.min(width / cal.imageWidth, (props.maxHeight ?? Infinity) / cal.imageHeight);
  const w = cal.imageWidth * k;
  const h = cal.imageHeight * k;
  const toScreen = useMemo(
    () => (v: Vec) => {
      const p = localToPixel(cal, v);
      return { x: p.x * k, y: p.y * k };
    },
    [cal, k],
  );
  const pts = (vs: Vec[]) => vs.map((v) => toScreen(v)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const metersToPx = 1 / cal.metersPerPixel * k;

  const onPress = (e: GestureResponderEvent) => {
    if (!props.onPressPixel) return;
    const { locationX, locationY } = e.nativeEvent;
    props.onPressPixel({ x: locationX / k, y: locationY / k });
  };

  const features = (props.features ?? []).filter((f) => props.showDismissed || f.status === 'active');

  return (
    <Pressable onPress={onPress} disabled={!props.onPressPixel} style={{ width: w, height: h, alignSelf: 'center' }} accessibilityLabel="Property map" accessibilityHint={props.onPressPixel ? 'Tap to place a point' : undefined}>
      <Image source={{ uri: props.imageUri }} style={{ width: w, height: h, opacity: t.name === 'redlight' ? 0.35 : 1 }} resizeMode="stretch" />
      <Svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        {/* Habitat inference: bedding and food areas */}
        {props.habitat?.food.map((f) =>
          f.polygon ? <Polygon key={f.id} points={pts(f.polygon)} fill={t.map.food} fillOpacity={0.18} stroke={t.map.food} strokeWidth={1} strokeDasharray="4 4" /> : null,
        )}
        {props.habitat?.bedding.map((b) =>
          b.polygon ? (
            <Polygon key={b.id} points={pts(b.polygon)} fill={t.map.bedding} fillOpacity={0.3} stroke={t.map.bedding} strokeWidth={2} />
          ) : (
            <Circle key={b.id} cx={toScreen(b.center).x} cy={toScreen(b.center).y} r={b.radiusM * metersToPx} fill={t.map.bedding} fillOpacity={0.3} stroke={t.map.bedding} strokeWidth={2} />
          ),
        )}
        {props.habitat?.corridors.slice(0, 8).map((c) => (
          <Polyline key={c.id} points={pts(c.points)} fill="none" stroke={t.map.corridor} strokeOpacity={0.35 + c.strength * 0.6} strokeWidth={2 + c.strength * 4} strokeDasharray="10 6" />
        ))}

        {/* Detected / hunter features */}
        {features.map((f) => {
          const color = featureColor(t, f.type);
          const sel = f.id === props.selectedFeatureId;
          const dim = f.status === 'dismissed' ? 0.25 : 1;
          const press = props.onPressFeature ? () => props.onPressFeature?.(f.id) : undefined;
          if (f.geometry.kind === 'polygon')
            return (
              <Polygon key={f.id} points={pts(f.geometry.points)} fill={color} fillOpacity={0.12 * dim} stroke={sel ? t.map.standSelected : color} strokeWidth={sel ? 3 : 1.5} strokeOpacity={dim} onPress={press} />
            );
          if (f.geometry.kind === 'line')
            return <Polyline key={f.id} points={pts(f.geometry.points)} fill="none" stroke={sel ? t.map.standSelected : color} strokeWidth={sel ? 4 : 2.5} strokeOpacity={dim} onPress={press} />;
          const p = toScreen(f.geometry.points[0]);
          return (
            <G key={f.id} onPress={press} opacity={dim}>
              <Circle cx={p.x} cy={p.y} r={sel ? 13 : 11} fill={t.bg} fillOpacity={0.8} stroke={sel ? t.map.standSelected : color} strokeWidth={2.5} />
              <SvgText x={p.x} y={p.y + 4} fontSize={11} fontWeight="bold" fill={color} textAnchor="middle">
                {POINT_GLYPH[f.type] ?? '•'}
              </SvgText>
            </G>
          );
        })}

        {/* Scent plumes for the selected stand: wind solid, thermals dashed */}
        {props.plumes?.plumes.map((pl, i) => {
          const origin = props.plumes!.origin;
          const len = Math.min(pl.lengthM, 300);
          const sector = sectorPolygon(origin, pl.bearingDeg, Math.min(pl.halfAngleDeg, 179), len, 10);
          const tip = add(origin, vscale(bearingVec(pl.bearingDeg), len * 0.55));
          const a = toScreen(origin);
          const b = toScreen(tip);
          const isThermal = pl.kind !== 'wind';
          const color = isThermal ? t.thermal : t.wind;
          return (
            <G key={`pl-${i}`}>
              <Polygon points={pts(sector)} fill={color} fillOpacity={isThermal ? 0.08 : 0.12} stroke={color} strokeOpacity={0.4} strokeDasharray={isThermal ? '5 5' : undefined} />
              {pl.kind !== 'swirl' ? <ArrowLine a={a} b={b} color={color} dashed={isThermal} /> : null}
            </G>
          );
        })}

        {/* Entry (solid) and exit (dashed) routes, colored per segment */}
        {props.routes?.map((r) =>
          r.segments.map((s, i) => (
            <Polyline
              key={`${r.kind}-${i}`}
              points={pts(s.points)}
              fill="none"
              stroke={t.status[s.status]}
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={r.kind === 'exit' ? '10 7' : undefined}
            />
          )),
        )}
        {props.routes?.map((r) => {
          const p = toScreen(r.kind === 'entry' ? r.points[0] : r.points[r.points.length - 1]);
          return <Circle key={`start-${r.kind}`} cx={p.x} cy={p.y} r={7} fill={r.kind === 'entry' ? t.route.entry : t.route.exit} stroke={t.bg} strokeWidth={2} />;
        })}

        {/* Stands */}
        {props.stands?.map((s) => {
          const p = toScreen(s.position);
          const r = s.selected ? 17 : 14;
          return (
            <G key={s.id} onPress={props.onPressStand ? () => props.onPressStand?.(s.id) : undefined}>
              <Circle cx={p.x} cy={p.y} r={r + 8} fill="transparent" />
              <Circle cx={p.x} cy={p.y} r={r} fill={s.selected ? t.map.standSelected : t.map.stand} stroke={t.bg} strokeWidth={2.5} />
              <SvgText x={p.x} y={p.y + 5} fontSize={14} fontWeight="bold" fill={t.accentText} textAnchor="middle">
                {s.rank ? (s.rank === 4 ? 'B' : String(s.rank)) : s.existing ? '★' : '•'}
              </SvgText>
            </G>
          );
        })}

        {/* Calibration pins */}
        {props.pins?.map((pin, i) => {
          const x = pin.pixel.x * k;
          const y = pin.pixel.y * k;
          return (
            <G key={`pin-${i}`}>
              <Line x1={x - 14} y1={y} x2={x + 14} y2={y} stroke={t.accent} strokeWidth={2} />
              <Line x1={x} y1={y - 14} x2={x} y2={y + 14} stroke={t.accent} strokeWidth={2} />
              <Circle cx={x} cy={y} r={9} fill="none" stroke={t.accent} strokeWidth={2.5} />
              <SvgText x={x + 12} y={y - 10} fontSize={13} fontWeight="bold" fill={t.accent}>
                {pin.label}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </Pressable>
  );
}

function ArrowLine({ a, b, color, dashed }: { a: { x: number; y: number }; b: { x: number; y: number }; color: string; dashed?: boolean }) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const head = 10;
  const l = { x: b.x - head * Math.cos(ang - 0.45), y: b.y - head * Math.sin(ang - 0.45) };
  const r = { x: b.x - head * Math.cos(ang + 0.45), y: b.y - head * Math.sin(ang + 0.45) };
  return (
    <G>
      <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={3} strokeDasharray={dashed ? '6 5' : undefined} />
      <Path d={`M${b.x},${b.y} L${l.x},${l.y} L${r.x},${r.y} Z`} fill={color} />
    </G>
  );
}

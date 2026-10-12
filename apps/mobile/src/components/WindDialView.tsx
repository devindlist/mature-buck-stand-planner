import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import { compass16, downwindBearing, type WindDial } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font } from '../theme/theme';

/**
 * 16-sector wind dial: each wedge is a wind FROM that direction.
 * Good = solid, caution = hatched outline, bad = X-marked: readable without color.
 */
export function WindDialView({ dial, size = 150 }: { dial: WindDial; size?: number }) {
  const t = useTheme();
  const c = size / 2;
  const rOuter = c - 14;
  const rInner = rOuter * 0.42;
  const wedge = (fromDeg: number) => {
    const a0 = ((fromDeg - 11.25 - 90) * Math.PI) / 180;
    const a1 = ((fromDeg + 11.25 - 90) * Math.PI) / 180;
    const p = (r: number, a: number) => `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`;
    return `M${p(rInner, a0)} L${p(rOuter, a0)} A${rOuter},${rOuter} 0 0 1 ${p(rOuter, a1)} L${p(rInner, a1)} A${rInner},${rInner} 0 0 0 ${p(rInner, a0)} Z`;
  };
  const good = dial.sectors.filter((s) => s.status === 'good').map((s) => compass16(s.fromDeg));
  const bad = dial.sectors.filter((s) => s.status === 'bad').map((s) => compass16(s.fromDeg));
  const arrowRot = downwindBearing(dial.currentFromDeg);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} accessible accessibilityLabel={`Good winds: ${good.join(', ') || 'none'}. Bad winds: ${bad.join(', ') || 'none'}.`}>
      <Svg width={size} height={size}>
        {dial.sectors.map((s) => {
          const color = t.dial[s.status];
          const mid = ((s.fromDeg - 90) * Math.PI) / 180;
          const rm = (rOuter + rInner) / 2;
          return (
            <G key={s.fromDeg}>
              <Path d={wedge(s.fromDeg)} fill={color} fillOpacity={s.status === 'good' ? 0.85 : s.status === 'caution' ? 0.35 : 0.15} stroke={t.bg} strokeWidth={1.5} />
              {s.status === 'bad' ? (
                <SvgText x={c + rm * Math.cos(mid)} y={c + rm * Math.sin(mid) + 4} fontSize={11} fontWeight="bold" fill={color} textAnchor="middle">
                  ✕
                </SvgText>
              ) : s.status === 'caution' ? (
                <SvgText x={c + rm * Math.cos(mid)} y={c + rm * Math.sin(mid) + 4} fontSize={11} fontWeight="bold" fill={color} textAnchor="middle">
                  !
                </SvgText>
              ) : null}
            </G>
          );
        })}
        {['N', 'E', 'S', 'W'].map((l, i) => {
          const a = ((i * 90 - 90) * Math.PI) / 180;
          return (
            <SvgText key={l} x={c + (rOuter + 8) * Math.cos(a)} y={c + (rOuter + 8) * Math.sin(a) + 4} fontSize={11} fill={t.textDim} textAnchor="middle" fontWeight="bold">
              {l}
            </SvgText>
          );
        })}
        <Circle cx={c} cy={c} r={rInner - 3} fill={t.surface} />
        <G rotation={arrowRot} origin={`${c},${c}`}>
          <Path d={`M${c},${c - rInner + 8} L${c + 8},${c + 6} L${c + 3},${c + 4} L${c + 3},${c + rInner - 10} L${c - 3},${c + rInner - 10} L${c - 3},${c + 4} L${c - 8},${c + 6} Z`} fill={t.wind} />
        </G>
      </Svg>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.status.safe, fontWeight: '800', fontSize: font.sm }}>✓ Good</Text>
        <Text style={{ color: t.text, fontSize: font.sm, marginBottom: 6 }}>{good.join(' ') || 'none'}</Text>
        <Text style={{ color: t.status.avoid, fontWeight: '800', fontSize: font.sm }}>✕ Bad</Text>
        <Text style={{ color: t.text, fontSize: font.sm }}>{bad.join(' ') || 'none'}</Text>
      </View>
    </View>
  );
}

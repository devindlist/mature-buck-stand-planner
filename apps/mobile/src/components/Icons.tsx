import React from 'react';
import Svg, { Circle, Line, Path, Polygon } from 'react-native-svg';
import type { Status } from '@msp/engine';

/** Status icons: shape carries meaning, so red-light mode (all red) still reads. */
export function StatusIcon({ status, color, size = 20 }: { status: Status | 'go' | 'no_go'; color: string; size?: number }) {
  const s = status === 'go' ? 'safe' : status === 'no_go' ? 'avoid' : status;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityRole="image">
      {s === 'safe' && (
        <>
          <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2.5} fill="none" />
          <Path d="M7 12.5l3.2 3.2L17 9" stroke={color} strokeWidth={2.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {s === 'caution' && (
        <>
          <Polygon points="12,2.5 22.5,21 1.5,21" stroke={color} strokeWidth={2.2} fill="none" strokeLinejoin="round" />
          <Line x1={12} y1={9} x2={12} y2={14.5} stroke={color} strokeWidth={2.8} strokeLinecap="round" />
          <Circle cx={12} cy={17.8} r={1.5} fill={color} />
        </>
      )}
      {s === 'avoid' && (
        <>
          <Path d="M8 2.5h8l5.5 5.5v8L16 21.5H8L2.5 16V8z" stroke={color} strokeWidth={2.2} fill="none" strokeLinejoin="round" />
          <Path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke={color} strokeWidth={2.8} strokeLinecap="round" />
        </>
      )}
    </Svg>
  );
}

/** Arrow pointing the way the wind BLOWS (i.e. where your scent goes). */
export function WindArrow({ downwindDeg, color, size = 32 }: { downwindDeg: number; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={{ transform: [{ rotate: `${downwindDeg}deg` }] }}>
      <Path d="M16 3 L24 17 L18.5 15.5 L18.5 29 L13.5 29 L13.5 15.5 L8 17 Z" fill={color} />
    </Svg>
  );
}

export function LowConfidenceTag({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} fill="none" strokeDasharray="3 3" />
      <Path d="M9.5 9a2.6 2.6 0 1 1 3.5 2.4c-.8.3-1 .9-1 1.6" stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Circle cx={12} cy={17} r={1.2} fill={color} />
    </Svg>
  );
}

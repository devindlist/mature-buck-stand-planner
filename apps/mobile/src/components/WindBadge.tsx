import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { compass16, downwindBearing } from '@msp/engine';
import { useAppStore } from '../state/store';
import { useTheme } from '../theme/ThemeContext';
import { WindArrow } from './Icons';
import { font } from '../theme/theme';

/** Width every screen header reserves on the right so the badge never moves. */
export const WIND_BADGE_RESERVED = 112;

/**
 * The wind arrow lives in the SAME spot on every screen (top-right), rendered once
 * by the root layout above all screens. The arrow points where scent goes.
 * Hunter overrides are marked with a dot.
 */
export function WindBadge() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const weather = useAppStore((s) => s.weather);
  const overrides = useAppStore((s) => s.draft.overrides);
  const from = overrides.windFromDeg ?? weather?.windFromDeg;
  const speed = overrides.windSpeedMph ?? weather?.windSpeedMph;
  const edited = overrides.windFromDeg !== undefined || overrides.windSpeedMph !== undefined;
  const label = from === undefined ? 'Wind not set' : `Wind from ${compass16(from)} at ${Math.round(speed ?? 0)} miles per hour. Scent blows ${compass16(downwindBearing(from))}.`;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, right: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens wind settings"
        onPress={() => router.push('/plan')}
        style={{ minWidth: 96, minHeight: 56, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}
      >
        {from === undefined ? (
          <Text style={{ color: t.textDim, fontSize: font.sm }}>No wind</Text>
        ) : (
          <>
            <WindArrow downwindDeg={downwindBearing(from)} color={t.wind} size={34} />
            <View style={{ marginLeft: 4 }}>
              <Text style={{ color: t.text, fontWeight: '800', fontSize: font.md }}>{compass16(from)}</Text>
              <Text style={{ color: t.textDim, fontSize: font.xs }}>
                {Math.round(speed ?? 0)} mph{edited ? ' •' : ''}
              </Text>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}

import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext';
import { WindBadge } from '../src/components/WindBadge';
import { useAppStore, DEFAULT_SETTINGS, type Settings } from '../src/state/store';
import { getSetting, latestPlan, listProperties } from '../src/db/repos';
import { getDb } from '../src/db/database';

function Shell() {
  const t = useTheme();
  const ready = useAppStore((s) => s.ready);
  const set = useAppStore((s) => s.set);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await getDb();
        const [settings, properties, plan, activeId] = await Promise.all([
          getSetting<Settings>('settings', DEFAULT_SETTINGS),
          listProperties(),
          latestPlan(),
          getSetting<string | null>('activePropertyId', null),
        ]);
        const merged = { ...DEFAULT_SETTINGS, ...settings };
        set({
          settings: merged,
          properties,
          activePropertyId: activeId ?? properties[0]?.id ?? null,
          plan,
          draft: { ...useAppStore.getState().draft, weaponType: merged.defaultWeapon, rangeYds: merged.defaultRangeYds },
          ready: true,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not open encrypted storage.');
      }
    })();
  }, [set]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: error ? t.danger : t.textDim, fontSize: 17, textAlign: 'center' }}>{error ?? 'Opening encrypted storage…'}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg }, animation: 'fade' }} />
      {/* Rendered once, above every screen, so the wind arrow is always in the same spot. */}
      <WindBadge />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

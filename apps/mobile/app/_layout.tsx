import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext';
import { WindBadge } from '../src/components/WindBadge';
import { BigButton } from '../src/components/ui';
import { useAppStore, DEFAULT_SETTINGS, defaultRangeFor, type Settings } from '../src/state/store';
import { getSetting, latestPlan, listProperties } from '../src/db/repos';
import { getDb, resetEncryptedStorage, StorageOpenError } from '../src/db/database';
import { ensureCheckInChannel, onCheckInNotificationTap } from '../src/services/checkin';
import { restoreActiveHunt } from '../src/services/huntSession';
import { font, SPACE } from '../src/theme/theme';

interface BootError {
  message: string;
  /** Offer "Start fresh" (erase what can't be read). */
  resettable: boolean;
  /** The data can't be decrypted on this phone (restored backup / new phone). */
  unreadable: boolean;
}

function toBootError(e: unknown): BootError {
  if (e instanceof StorageOpenError || (e instanceof Error && e.name === 'StorageOpenError')) {
    const se = e as StorageOpenError;
    return { message: se.message, resettable: se.resettable !== false, unreadable: se.kind === 'key_missing' || se.kind === 'wrong_key' };
  }
  return { message: e instanceof Error ? e.message : 'Could not open encrypted storage.', resettable: true, unreadable: false };
}

function Shell() {
  const t = useTheme();
  const ready = useAppStore((s) => s.ready);
  const set = useAppStore((s) => s.set);
  const [error, setError] = useState<BootError | null>(null);
  const [busy, setBusy] = useState(false);

  const boot = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await getDb();
      const [settings, properties, plan, activeId] = await Promise.all([
        getSetting<Settings>('settings', DEFAULT_SETTINGS),
        listProperties(),
        latestPlan(),
        getSetting<string | null>('activePropertyId', null),
      ]);
      const merged = { ...DEFAULT_SETTINGS, ...settings };
      // A hunt that was running when the app was killed comes back with its alarms. The
      // session itself is restored first; don't hold the app hostage to the alarm check.
      await Promise.race([restoreActiveHunt().catch(() => null), new Promise((r) => setTimeout(r, 3_000))]);
      set({
        settings: merged,
        properties,
        activePropertyId: activeId ?? properties[0]?.id ?? null,
        plan,
        // The saved range always goes with its own weapon (never "bow @ 200 yds").
        draft: { ...useAppStore.getState().draft, weaponType: merged.defaultWeapon, rangeYds: defaultRangeFor(merged.defaultWeapon, merged.defaultRangeYds) },
        ready: true,
      });
      void ensureCheckInChannel().catch(() => undefined);
    } catch (e) {
      setError(toBootError(e));
    } finally {
      setBusy(false);
    }
  }, [set]);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Tapping a check-in / overdue alert opens Hunt mode (check-in and SOS) when a hunt is on.
  useEffect(() => {
    if (!ready) return;
    return onCheckInNotificationTap(() => {
      if (useAppStore.getState().hunt) router.push('/hunt');
    });
  }, [ready]);

  const startFresh = () =>
    Alert.alert(
      'Erase and start fresh?',
      error?.unreadable
        ? "The data on this phone can't be unlocked here and can't be recovered. Starting fresh erases it (and its map photos) and sets up new encrypted storage."
        : 'This erases all Stand Planner data on this phone (properties, plans, hunts, map photos, settings) and sets up new encrypted storage. Try again first if this might be temporary.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Erase and start fresh',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void resetEncryptedStorage()
              .then(boot)
              .catch((e: unknown) => {
                setError(toBootError(e));
                setBusy(false);
              });
          },
        },
      ],
    );

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center' }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
          {error ? (
            <>
              <Text style={{ color: t.danger, fontSize: font.lg, fontWeight: '900', textAlign: 'center' }}>Can't open your data</Text>
              <Text style={{ color: t.text, fontSize: font.md, textAlign: 'center', marginTop: SPACE }}>{error.message}</Text>
              <BigButton label="Try again" kind="secondary" loading={busy} onPress={() => void boot()} style={{ marginTop: SPACE * 2 }} />
              {error.resettable ? <BigButton label="Erase and start fresh" kind={error.unreadable ? 'primary' : 'danger'} disabled={busy} onPress={startFresh} /> : null}
            </>
          ) : (
            <Text style={{ color: t.textDim, fontSize: 17, textAlign: 'center' }}>Opening encrypted storage…</Text>
          )}
        </ScrollView>
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

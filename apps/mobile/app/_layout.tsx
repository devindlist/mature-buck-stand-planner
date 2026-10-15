import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, Text, View } from 'react-native';
import * as ExpoRouter from 'expo-router';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeContext';
import { WindBadge } from '../src/components/WindBadge';
import { BigButton } from '../src/components/ui';
import { useAppStore, defaultRangeFor, normalizeSettings } from '../src/state/store';
import { getSetting, latestPlan, listProperties, restoreMapPhotoCache } from '../src/db/repos';
import { getDb, resetEncryptedStorage, StorageOpenError } from '../src/db/database';
import { cancelAllScheduled, ensureCheckInChannel, onCheckInNotificationTap } from '../src/services/checkin';
import { deleteOfflineMaps } from '../src/services/dataReset';
import { closeStaleHunt, restoreActiveHunt, takeAutoEndedHunt } from '../src/services/huntSession';
import { font, SPACE } from '../src/theme/theme';

interface BootError {
  message: string;
  /** Offer "Start fresh" (erase what can't be read). */
  resettable: boolean;
  /** The data can't be decrypted on this phone (restored backup / new phone). */
  unreadable: boolean;
}

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Tells the hunter once that a hunt left open long past its check-in was closed (reminders cancelled, saved as aborted). */
function announceClosedHunt(): void {
  const closed = takeAutoEndedHunt();
  if (!closed) return;
  Alert.alert(
    'An old hunt was closed',
    `${closed.standName ?? 'A hunt'} was still open from ${fmtDateTime(closed.startedAt)}, well past its check-in time. Its reminders were cancelled and it was saved as aborted. If you are safe, no action is needed.`,
  );
}

/** The route path (e.g. '/hunt'), via the one expo-router hook we need, typed here on its own. */
const usePathname = (ExpoRouter as unknown as { usePathname(): string }).usePathname;

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
  // The notification-tap handler is subscribed once; it reads the current route from a ref.
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const boot = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await getDb();
      const [saved, properties, plan, activeId] = await Promise.all([
        getSetting<unknown>('settings', null),
        listProperties(),
        latestPlan(),
        getSetting<string | null>('activePropertyId', null),
      ]);
      const merged = normalizeSettings(saved);
      // A hunt that was running when the app was killed comes back with its alarms. The
      // session itself is restored first; don't hold the app hostage to the alarm check.
      const restoring = restoreActiveHunt().catch(() => null);
      await Promise.race([restoring, new Promise((r) => setTimeout(r, 3_000))]);
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
      // A hunt left open long past its check-in is closed while restoring: say so once, however
      // long the restore takes.
      void restoring.then(announceClosedHunt);
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
  // The alert usually fires while the hunter is already ON Hunt mode: then there is nothing
  // to open (a second Hunt screen would double the clock and wind poll, and leave a stale
  // screen behind after End hunt).
  useEffect(() => {
    if (!ready) return;
    return onCheckInNotificationTap(() => {
      if (!useAppStore.getState().hunt) return;
      if (pathRef.current === '/hunt') return;
      router.push('/hunt');
    });
  }, [ready]);

  // Whenever the app comes back to the foreground: a purged cache must not leave a map blank
  // (put the photo files back from the encrypted database), and a hunt left open for days in a
  // process that was never restarted is closed like a restart would.
  useEffect(() => {
    if (!ready) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void restoreMapPhotoCache(useAppStore.getState().properties).catch(() => undefined);
      void closeStaleHunt().then(announceClosedHunt).catch(() => undefined);
    });
    return () => sub.remove();
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
            // Alarms live in the OS and survive the wipe: cancel them first (best effort), or
            // a check-in / OVERDUE alert would fire later for a hunt that no longer exists.
            void cancelAllScheduled()
              .catch(() => undefined)
              // Offline basemap packs show where the property is, so they go too (best effort).
              .then(() => deleteOfflineMaps().catch(() => undefined))
              .then(() => resetEncryptedStorage())
              .then(async (report) => {
                await boot();
                if (!report.photosRemoved) Alert.alert('Some map photo copies were left', 'Your data was erased, but a few temporary map photo files could not be deleted. Restarting the app or deleting everything again from Settings will remove them.');
              })
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

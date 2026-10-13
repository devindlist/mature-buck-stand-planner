import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Haptics from 'expo-haptics';
import type { LatLon } from '@msp/engine';

/** Resolves to null instead of hanging or throwing. GPS calls can take minutes under canopy. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

type Position = { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp: number };
const toFix = (p: Position): LocationFix => ({ point: { lat: p.coords.latitude, lon: p.coords.longitude }, at: new Date(p.timestamp).toISOString(), accuracyM: p.coords.accuracy ?? undefined });

export interface LocationFix {
  point: LatLon;
  /** When the fix was taken. */
  at: string;
  accuracyM?: number;
}

/**
 * One-shot, balanced-accuracy fix. No background location, ever.
 * Never hangs: after `timeoutMs` it settles for the last known position, or null.
 */
export async function currentLocation(timeoutMs = 20_000): Promise<LatLon | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  const last: Position | null = await within(Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000, requiredAccuracy: 200 }), 2_000);
  if (last) return toFix(last).point;
  const pos: Position | null = await within(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), timeoutMs);
  if (pos) return toFix(pos).point;
  const stale: Position | null = await within(Location.getLastKnownPositionAsync(), 2_000);
  return stale ? toFix(stale).point : null;
}

/** Ask for location once, up front (Hunt mode start), so an emergency never waits on a prompt. */
export async function ensureLocationPermission(): Promise<boolean> {
  const r: { status: string } | null = await within(Location.requestForegroundPermissionsAsync(), 60_000);
  return r?.status === 'granted';
}

/**
 * For the SOS text: the best position available within `timeoutMs`, never prompting and
 * never blocking longer. A fresh fix wins; otherwise the last known one (with its time).
 */
export async function quickLocation(timeoutMs = 4_000): Promise<LocationFix | null> {
  const perm: { status: string } | null = await within(Location.getForegroundPermissionsAsync(), 1_000);
  if (perm?.status !== 'granted') return null;
  const lastP = within<Position | null>(Location.getLastKnownPositionAsync(), Math.min(1_500, timeoutMs));
  const fresh: Position | null = await within(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), timeoutMs);
  if (fresh) return toFix(fresh);
  const last = await lastP;
  return last ? toFix(last) : null;
}

/**
 * Battery-aware polling interval for Hunt mode's wind check.
 * Low battery or Low Power Mode stretches it; the hunter can always tap to refresh.
 */
export async function windPollMinutes(): Promise<number> {
  try {
    const [level, lowPower] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.isLowPowerModeEnabledAsync()]);
    if (lowPower || level < 0.2) return 60;
    if (level < 0.5) return 30;
    return 15;
  } catch {
    return 30;
  }
}

/** Silent by default: haptics only if the hunter opted in. */
export function tap(enabled: boolean): void {
  if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

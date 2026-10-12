import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Haptics from 'expo-haptics';
import type { LatLon } from '@msp/engine';

/** One-shot, balanced-accuracy fix. No background location, ever. */
export async function currentLocation(): Promise<LatLon | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  const last = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000, requiredAccuracy: 200 });
  if (last) return { lat: last.coords.latitude, lon: last.coords.longitude };
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
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

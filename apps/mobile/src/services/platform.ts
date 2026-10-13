import * as ReactNative from 'react-native';

/**
 * The few react-native platform APIs the safety code needs (OS checks and opening the
 * app's system settings page), behind one small typed seam.
 */
interface PlatformApis {
  Platform: { OS: string; Version: number | string };
  Linking: { openSettings(): Promise<void> };
}

const rn = ReactNative as unknown as PlatformApis;

export const isAndroid = rn.Platform.OS === 'android';
export const isIOS = rn.Platform.OS === 'ios';
/** Android API level (0 elsewhere). */
export const androidApiLevel = isAndroid ? Number(rn.Platform.Version) || 0 : 0;

/** Opens this app's page in the system Settings (notifications, location, alarms). */
export async function openAppSettings(): Promise<boolean> {
  try {
    await rn.Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}

import * as Notifications from 'expo-notifications';
import * as SMS from 'expo-sms';
import type { LatLon } from '@msp/engine';

/**
 * Safety check-in timer.
 *
 * Phase 1 is device-only: at the due time the phone shows a (vibrate-only) reminder to
 * check in, and 30 minutes later an "overdue" alert that opens a pre-filled text to
 * the emergency contact. Phone OSes do not let an app send SMS silently, so a true
 * dead-man's switch (auto-alert when the hunter can't respond) needs a server and is
 * planned for Phase 2. The UI says this plainly.
 */
export const OVERDUE_GRACE_MIN = 30;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function ensureNotificationPermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted;
}

export async function armCheckIn(dueAtIso: string, standName: string): Promise<string[]> {
  if (!(await ensureNotificationPermission())) return [];
  const due = new Date(dueAtIso);
  const overdue = new Date(due.getTime() + OVERDUE_GRACE_MIN * 60_000);
  const ids: string[] = [];
  ids.push(
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Check in', body: `Tap to confirm you're safe at ${standName}.`, sound: false, data: { kind: 'checkin' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: due },
    }),
  );
  ids.push(
    await Notifications.scheduleNotificationAsync({
      content: { title: 'OVERDUE: check in now', body: 'Open to check in or text your emergency contact.', sound: false, data: { kind: 'overdue' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: overdue },
    }),
  );
  return ids;
}

export async function cancelCheckIn(ids: string[] | undefined): Promise<void> {
  for (const id of ids ?? []) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
}

export function emergencyMessage(name: string, standName: string, propertyName: string, gps: LatLon | null): string {
  const where = gps ? `https://maps.google.com/?q=${gps.lat.toFixed(5)},${gps.lon.toFixed(5)}` : 'location unavailable';
  return `${name ? `${name}, ` : ''}I haven't checked in from my hunt at ${propertyName} (${standName}). Last location: ${where}. Please call me, and if you can't reach me, send help.`;
}

export async function textEmergencyContact(phone: string, message: string): Promise<boolean> {
  if (!phone || !(await SMS.isAvailableAsync())) return false;
  const r = await SMS.sendSMSAsync([phone], message);
  return r.result === 'sent' || r.result === 'unknown';
}

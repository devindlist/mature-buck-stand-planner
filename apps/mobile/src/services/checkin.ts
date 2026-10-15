import * as Notifications from 'expo-notifications';
import * as SMS from 'expo-sms';
import type { LatLon } from '@msp/engine';
import { fmtTime } from '../utils/format';
import { isAndroid, isIOS } from './platform';

/**
 * Safety check-in timer.
 *
 * Phase 1 is device-only: at the due time the phone shows a reminder to check in, and
 * 30 minutes later an "overdue" alert that opens a pre-filled text to the emergency
 * contact. Phone OSes do not let an app send SMS silently, so a true dead-man's switch
 * (auto-alert when the hunter can't respond) needs a server and is planned for Phase 2.
 * The UI says this plainly.
 *
 * How the reminders get noticed without a sound:
 *  - Android: a dedicated channel with NO sound and a vibration pattern (on Android 8+ the
 *    channel, not the notification, decides sound and vibration).
 *  - iOS: an app can't ask for "vibrate only". The reminders use the system alert, which
 *    only vibrates when the ring switch is on silent. Hunt mode tells the hunter so.
 *
 * Arming never fails silently: armCheckIn reports whether anything was scheduled and why
 * not, and Hunt mode shows a red banner when no reminder will fire.
 *
 * Platform requirements that cannot be checked from JavaScript:
 *  - Android 12+ delays reminders unless "Alarms & reminders" is allowed for the app.
 *    SCHEDULE_EXACT_ALARM is declared once in app.json; whether the hunter has granted it
 *    cannot be read without a native module, so Settings and Hunt mode show a standing
 *    note and an "Open app settings" button instead of guessing.
 *  - iOS 'timeSensitive' alerts (below) need the com.apple.developer.usernotifications.
 *    time-sensitive entitlement in app.json. They let the pre-dawn check-in through a Sleep
 *    or Do Not Disturb Focus, which is the point of a safety reminder. Without the
 *    entitlement iOS still delivers the alert as a normal one; the only cost is that a
 *    build signed with a free Apple "Personal Team" may refuse to provision: for such a
 *    local build remove that entitlement from app.json (the reminders still fire).
 */
export const OVERDUE_GRACE_MIN = 30;
export const CHECKIN_CHANNEL_ID = 'checkin';
const VIBRATION_PATTERN = [0, 400, 200, 400, 200, 400];
const CHECKIN_KINDS = ['checkin', 'overdue'];

export const NOTIFICATIONS_OFF = 'Notifications are turned off for Stand Planner, so no check-in reminder can fire. Turn them on in Settings.';
const CHANNEL_OFF = 'Check-in reminders are turned off in Android settings for this app. Turn the "Check-in reminders" category back on.';
const ALERTS_OFF = 'Notification alerts are off for Stand Planner in iPhone Settings, so a reminder would not show. Turn on Lock Screen and Banners.';

function isCheckInData(data: unknown): boolean {
  const kind = (data as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' && CHECKIN_KINDS.includes(kind);
}

Notifications.setNotificationHandler({
  // In the foreground the check-in alerts behave as in the background (vibrate on Android's
  // silent channel, system alert on iOS); everything else stays silent.
  handleNotification: async (n: { request?: { content?: { data?: unknown } } }) => ({
    shouldShowAlert: true,
    shouldPlaySound: isCheckInData(n?.request?.content?.data),
    shouldSetBadge: false,
  }),
});

let channelReady: Promise<void> | null = null;

/**
 * Android: the vibrate-only, no-sound channel the check-in alerts post to. Created once;
 * Android 13+ also needs a channel to exist before the permission prompt can appear.
 * A no-op elsewhere.
 */
export function ensureCheckInChannel(): Promise<void> {
  if (!isAndroid) return Promise.resolve();
  if (!channelReady) {
    channelReady = Promise.resolve(
      Notifications.setNotificationChannelAsync(CHECKIN_CHANNEL_ID, {
        name: 'Check-in reminders',
        description: 'Safety check-in and overdue alerts while you hunt. Vibrate only, never a sound.',
        importance: Notifications.AndroidImportance.HIGH,
        sound: null,
        enableVibrate: true,
        vibrationPattern: VIBRATION_PATTERN,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: false,
      }),
    )
      .then(() => undefined)
      .catch((e: unknown) => {
        channelReady = null;
        throw e;
      });
  }
  return channelReady;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  await ensureCheckInChannel().catch(() => undefined);
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (cur.canAskAgain === false) return false;
  const req = await Notifications.requestPermissionsAsync();
  return !!req.granted;
}

/** Why a check-in reminder would not show right now (never prompts). undefined = OK. */
export async function checkInBlockedReason(): Promise<string | undefined> {
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) return NOTIFICATIONS_OFF;
  if (isIOS && perm.ios && perm.ios.allowsAlert === false) return ALERTS_OFF;
  if (isAndroid) {
    const ch = await Notifications.getNotificationChannelAsync(CHECKIN_CHANNEL_ID).catch(() => null);
    if (ch && ch.importance === Notifications.AndroidImportance.NONE) return CHANNEL_OFF;
  }
  return undefined;
}

export interface CheckInArmResult {
  /** True when at least one future reminder is scheduled with the OS. */
  armed: boolean;
  ids: string[];
  /** Plain-language reason when not armed. */
  reason?: string;
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'unknown error');

/**
 * Schedules the check-in reminder at `dueAtIso` and the overdue alert 30 minutes later.
 * Times already in the past are skipped (e.g. re-arming after a restart).
 */
export async function armCheckIn(dueAtIso: string, standName: string): Promise<CheckInArmResult> {
  try {
    if (!(await ensureNotificationPermission())) return { armed: false, ids: [], reason: NOTIFICATIONS_OFF };
    const blocked = await checkInBlockedReason();
    if (blocked) return { armed: false, ids: [], reason: blocked };
    const due = Date.parse(dueAtIso);
    if (!Number.isFinite(due)) return { armed: false, ids: [], reason: 'The check-in time is not valid.' };
    const alerts = [
      { at: due, kind: 'checkin', title: 'Check in', body: `Open Stand Planner and tap "I'm safe" (${standName}).` },
      { at: due + OVERDUE_GRACE_MIN * 60_000, kind: 'overdue', title: 'OVERDUE: check in now', body: 'Open Stand Planner to check in or text your emergency contact.' },
    ].filter((a) => a.at > Date.now() + 5_000);
    if (!alerts.length) return { armed: false, ids: [], reason: 'That check-in time has already passed.' };
    const ids: string[] = [];
    try {
      for (const a of alerts) {
        ids.push(
          await Notifications.scheduleNotificationAsync({
            content: {
              title: a.title,
              body: a.body,
              data: { kind: a.kind },
              // iOS: the system alert (vibrates only with the ring switch on silent). Android: the
              // channel decides (no sound); the pattern covers Android 7, which has no channels.
              sound: isIOS ? 'default' : false,
              vibrate: VIBRATION_PATTERN,
              priority: Notifications.AndroidNotificationPriority.MAX,
              interruptionLevel: 'timeSensitive',
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(a.at), channelId: CHECKIN_CHANNEL_ID },
          }),
        );
      }
    } catch (e) {
      await cancelCheckIn(ids);
      return { armed: false, ids: [], reason: `The phone refused to schedule the reminder (${errText(e)}).` };
    }
    return { armed: true, ids };
  } catch (e) {
    return { armed: false, ids: [], reason: `Could not set up check-in reminders (${errText(e)}).` };
  }
}

export async function cancelCheckIn(ids: string[] | undefined): Promise<void> {
  for (const id of ids ?? []) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
}

/**
 * Cancels EVERY scheduled check-in/overdue alert (not just the ids we remember), and with
 * `dismissDelivered` also clears delivered ones from the tray. Used whenever a hunt ends or
 * the hunter checks in, so an alarm can't be orphaned.
 */
export async function cancelAllCheckIns(opts: { dismissDelivered?: boolean } = {}): Promise<void> {
  const scheduled: Array<{ identifier: string; content?: { data?: unknown } }> = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of scheduled) {
    if (isCheckInData(n.content?.data)) await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => undefined);
  }
  if (!opts.dismissDelivered) return;
  const presented: Array<{ request?: { identifier: string; content?: { data?: unknown } } }> = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  for (const n of presented) {
    if (n.request && isCheckInData(n.request.content?.data)) await Notifications.dismissNotificationAsync(n.request.identifier).catch(() => undefined);
  }
}

/** Kinds ('checkin' / 'overdue') the OS still holds for later, or null if it can't be read. */
export async function pendingCheckInKinds(): Promise<Set<string> | null> {
  try {
    const scheduled: Array<{ content?: { data?: { kind?: unknown } } }> = await Notifications.getAllScheduledNotificationsAsync();
    const kinds = new Set<string>();
    for (const n of scheduled) if (isCheckInData(n.content?.data)) kinds.add(String(n.content?.data?.kind));
    return kinds;
  } catch {
    return null;
  }
}

/** Hunter-initiated wipe: drop every scheduled alert this app made. */
export async function cancelAllScheduled(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined);
  await cancelAllCheckIns({ dismissDelivered: true });
}

/**
 * Calls `onTap` when the hunter taps a check-in or overdue alert, including the tap that
 * cold-started the app. Returns an unsubscribe function.
 */
export function onCheckInNotificationTap(onTap: () => void): () => void {
  type Resp = { notification?: { request?: { content?: { data?: unknown } } } } | null;
  const handle = (r: Resp) => {
    if (r && isCheckInData(r.notification?.request?.content?.data)) onTap();
  };
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  void Promise.resolve(Notifications.getLastNotificationResponseAsync())
    .then(handle)
    .catch(() => undefined);
  return () => sub.remove();
}

export function emergencyMessage(name: string, standName: string, propertyName: string, gps: LatLon | null, extra: { fixAt?: string; standGeo?: LatLon } = {}): string {
  const link = (p: LatLon) => `https://maps.google.com/?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  const where = gps ? `${link(gps)}${extra.fixAt ? ` (as of ${fmtTime(extra.fixAt)})` : ''}` : 'GPS unavailable';
  const stand = extra.standGeo ? ` My stand is at ${link(extra.standGeo)}.` : '';
  return `${name ? `${name}, ` : ''}I haven't checked in from my hunt at ${propertyName} (${standName}). Last location: ${where}.${stand} Please call me, and if you can't reach me, send help.`;
}

/** Opens the SMS composer pre-filled. False only when it could not be opened. */
export async function textEmergencyContact(phone: string, message: string): Promise<boolean> {
  try {
    if (!phone || !(await SMS.isAvailableAsync())) return false;
    await SMS.sendSMSAsync([phone], message);
    return true;
  } catch {
    return false;
  }
}

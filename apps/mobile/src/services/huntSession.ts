import { localToGeo, type LatLon, type Plan, type StandRecommendation } from '@msp/engine';
import { useAppStore, type HuntSession } from '../state/store';
import { getHunt, getSetting, saveHunt, savePressure, setSetting } from '../db/repos';
import { armCheckIn, cancelAllCheckIns, cancelCheckIn, checkInBlockedReason, OVERDUE_GRACE_MIN, pendingCheckInKinds, type CheckInArmResult } from './checkin';
import { uid } from '../utils/format';

/**
 * The one place a hunt session starts, changes and ends.
 *
 * Life-safety rules this enforces:
 *  - the session (with its notification ids) is persisted on every change, so it survives
 *    the OS killing the app during a long sit, and is restored at launch;
 *  - ending a session ALWAYS cancels its alarms (and sweeps any orphaned check-in alarm);
 *  - arming results are stored on the session (checkInArmed / checkInProblem) so Hunt
 *    mode can say loudly when no reminder will fire;
 *  - changes run one at a time, so two quick taps can't leave an alarm nobody can cancel.
 */
const ACTIVE_KEY = 'activeHunt';

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const store = () => useAppStore.getState();

async function commit(session: HuntSession | null): Promise<void> {
  store().set({ hunt: session });
  try {
    await setSetting(ACTIVE_KEY, session);
  } catch {
    /* The in-memory session keeps working; the next change persists again. */
  }
}

/** Stores an arming result on the session it was made for (or cancels it if that session is gone). */
async function applyArm(huntId: string, r: CheckInArmResult): Promise<void> {
  const cur = store().hunt;
  if (!cur || cur.huntId !== huntId) {
    await cancelCheckIn(r.ids);
    return;
  }
  await commit({ ...cur, checkInNotificationIds: r.ids, checkInArmed: r.armed, checkInProblem: r.armed ? undefined : r.reason });
}

async function arm(session: HuntSession, dueIso: string): Promise<CheckInArmResult> {
  let r: CheckInArmResult;
  try {
    r = await armCheckIn(dueIso, session.standName ?? 'your stand');
  } catch (e) {
    r = { armed: false, ids: [], reason: `Could not set up check-in reminders (${e instanceof Error ? e.message : 'unknown error'}).` };
  }
  await applyArm(session.huntId, r);
  return r;
}

async function endInternal(): Promise<HuntSession | null> {
  const cur = store().hunt;
  await cancelCheckIn(cur?.checkInNotificationIds);
  await cancelAllCheckIns({ dismissDelivered: true });
  if (!cur) {
    await setSetting(ACTIVE_KEY, null).catch(() => undefined);
    return null;
  }
  const endedAt = new Date().toISOString();
  const ended: HuntSession = { ...cur, endedAt, checkInNotificationIds: [], checkInArmed: undefined, checkInProblem: undefined };
  store().set({ hunt: null, endedHunt: ended });
  await setSetting(ACTIVE_KEY, null).catch(() => undefined);
  try {
    const h = await getHunt(cur.huntId);
    if (h) await saveHunt({ ...h, endedAt, checkIn: h.checkIn ? { ...h.checkIn, status: 'checked_in' } : h.checkIn });
    // Every sit is pressure history for this stand.
    await savePressure({ id: uid('press'), propertyId: cur.propertyId, at: cur.startedAt, kind: 'sit', standId: cur.standId, position: cur.standPosition });
  } catch {
    /* History only: the alarms are already cancelled. */
  }
  return ended;
}

export interface StartHuntArgs {
  plan: Plan;
  rec: StandRecommendation;
  checkInMinutes: number;
  emergencyContact: { name: string; phone: string };
  /** The property's geo origin, when the map is geo-referenced (for the SOS stand location). */
  origin?: LatLon;
}

/** Starts a new hunt at `rec` (ending any active one first) and arms the check-in. */
export function startHunt(a: StartHuntArgs): Promise<HuntSession> {
  return serial(async () => {
    if (store().hunt) await endInternal();
    const now = new Date();
    const due = new Date(now.getTime() + a.checkInMinutes * 60_000).toISOString();
    const session: HuntSession = {
      huntId: uid('hunt'),
      planId: a.plan.id,
      propertyId: a.plan.propertyId,
      standId: a.rec.stand.id,
      standName: a.rec.stand.name,
      standPosition: a.rec.stand.position,
      standGeo: a.origin ? localToGeo(a.rec.stand.position, a.origin) : undefined,
      startedAt: now.toISOString(),
      checkInDueAt: due,
      checkInNotificationIds: [],
    };
    await commit(session);
    await saveHunt({
      id: session.huntId,
      propertyId: session.propertyId,
      planId: session.planId,
      standId: session.standId,
      date: a.plan.inputs.date,
      window: a.plan.inputs.window,
      startedAt: session.startedAt,
      checkIn: { expectedBackAt: due, emergencyContactName: a.emergencyContact.name, emergencyContactPhone: a.emergencyContact.phone, status: 'armed' },
    }).catch(() => undefined);
    await arm(session, due);
    return store().hunt ?? session;
  });
}

/** "I'm safe" / "+30 min" / "Try again": replaces the alarms with new ones due at `dueIso`. */
export function resetCheckIn(dueIso: string): Promise<CheckInArmResult | null> {
  return serial(async () => {
    const cur = store().hunt;
    if (!cur) return null;
    await cancelCheckIn(cur.checkInNotificationIds);
    await cancelAllCheckIns({ dismissDelivered: true });
    const pending: HuntSession = { ...cur, checkInDueAt: dueIso, checkInNotificationIds: [], checkInArmed: undefined, checkInProblem: undefined };
    await commit(pending);
    const r = await arm(pending, dueIso);
    try {
      const h = await getHunt(cur.huntId);
      if (h?.checkIn) await saveHunt({ ...h, checkIn: { ...h.checkIn, expectedBackAt: dueIso, status: 'armed' } });
    } catch {
      /* history only */
    }
    return r;
  });
}

/** One tap in Hunt mode: the wind the hunter feels at the tree (FROM, degrees), or null to clear. */
export function setObservedWind(fromDeg: number | null): Promise<void> {
  return serial(async () => {
    const cur = store().hunt;
    if (!cur) return;
    await commit({ ...cur, observedWindFromDeg: fromDeg ?? undefined, observedWindAt: fromDeg === null ? undefined : new Date().toISOString() });
  });
}

/** Ends the active hunt: cancels every check-in alarm, clears the persisted session, records the sit. */
export function endActiveHunt(): Promise<HuntSession | null> {
  return serial(endInternal);
}

/**
 * Launch: brings back a hunt that was running when the app was killed, and makes sure the
 * OS still holds its alarms (re-arming whatever is missing). Never prompts.
 */
export function restoreActiveHunt(): Promise<HuntSession | null> {
  return serial(async () => {
    const saved = await getSetting<HuntSession | null>(ACTIVE_KEY, null);
    if (!saved?.huntId) return null;
    store().set({ hunt: saved });
    try {
      const blocked = await checkInBlockedReason();
      if (blocked) {
        await commit({ ...saved, checkInArmed: false, checkInProblem: blocked });
        return store().hunt;
      }
      const due = saved.checkInDueAt ? Date.parse(saved.checkInDueAt) : NaN;
      if (!Number.isFinite(due)) return saved;
      const now = Date.now();
      const expected = [due > now ? 'checkin' : '', due + OVERDUE_GRACE_MIN * 60_000 > now ? 'overdue' : ''].filter(Boolean);
      if (!expected.length) return saved; // Both alerts already fired: Hunt mode shows OVERDUE.
      const pending = await pendingCheckInKinds();
      if (pending === null) return saved;
      if (expected.every((k) => pending.has(k))) {
        if (saved.checkInArmed !== true) await commit({ ...saved, checkInArmed: true, checkInProblem: undefined });
        return store().hunt;
      }
      await cancelAllCheckIns({ dismissDelivered: false });
      await arm(saved, saved.checkInDueAt as string);
    } catch {
      /* Keep the restored session; Hunt mode still shows the countdown. */
    }
    return store().hunt;
  });
}

/** Delete all data: forget any hunt in memory (alarms are cancelled by the caller). */
export function forgetHunts(): Promise<void> {
  return serial(async () => {
    store().set({ hunt: null, endedHunt: null });
  });
}

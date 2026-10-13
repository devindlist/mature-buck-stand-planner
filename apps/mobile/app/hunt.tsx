import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { compass16, downwindBearing, type Decision, type Maturity, type Plan, type PlanCard, type Sighting, type StandRecommendation, type WeatherSnapshot } from '@msp/engine';
import { useAppStore, type HuntSession } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Screen, StatusChip } from '../src/components/ui';
import { StatusIcon } from '../src/components/Icons';
import { getPlan, saveSighting } from '../src/db/repos';
import { emergencyMessage, OVERDUE_GRACE_MIN, textEmergencyContact } from '../src/services/checkin';
import { ensureLocationPermission, quickLocation, tap, windPollMinutes } from '../src/services/device';
import { endActiveHunt, resetCheckIn, setObservedWind, startHunt } from '../src/services/huntSession';
import { androidApiLevel, isAndroid, openAppSettings } from '../src/services/platform';
import { loadForecast } from '../src/services/weather';
import { fmtDuration, fmtTime, minutesUntil, uid } from '../src/utils/format';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Hunt mode: red-light, minimal, silent. Live wind check against the stand's dial,
 * one-tap sighting log, and the safety check-in timer.
 *
 * Hunt mode runs on the ACTIVE SESSION's own plan and stand (loaded from the database if a
 * newer plan exists), never on "whatever plan is latest". A new session starts only when
 * the hunter picked a stand ("Hunt this stand" / plan card), and switching stands mid-hunt
 * asks first.
 */
const SIGHTINGS: Array<{ m: Maturity; label: string }> = [
  { m: 'mature_buck', label: 'MATURE BUCK' },
  { m: 'young_buck', label: 'Young buck' },
  { m: 'doe', label: 'Doe(s)' },
  { m: 'unknown', label: 'Other deer' },
];

const WIND_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];
/** A tapped "wind at the tree" stays authoritative this long. */
const OBSERVED_WIND_TTL_MIN = 180;

type DialStatus = 'good' | 'caution' | 'bad';
const RANK: Record<DialStatus, number> = { good: 0, caution: 1, bad: 2 };

const allRecs = (plan: Plan): StandRecommendation[] => [...plan.recommendations, ...(plan.backup ? [plan.backup] : []), ...(plan.yourStands ?? [])];

function dialStatus(rec: StandRecommendation, fromDeg: number): DialStatus {
  const from = ((fromDeg % 360) + 360) % 360;
  let best = rec.windDial.sectors[0];
  let bestDiff = 999;
  for (const s of rec.windDial.sectors) {
    const d = Math.abs(((s.fromDeg - from + 540) % 360) - 180);
    if (d < bestDiff) {
      best = s;
      bestDiff = d;
    }
  }
  return best?.status ?? 'caution';
}

/** The forecast wind for the hour we're in (not the sit midpoint), from the hourly forecast. */
function forecastWindNow(snap: WeatherSnapshot | undefined, now: number): { fromDeg: number; hourAt?: string } | null {
  if (!snap || snap.placeholder || snap.source === 'manual') return null;
  const hours = [...(snap.hourly ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let pick = hours[0];
  for (const h of hours) if (Date.parse(h.at) <= now) pick = h;
  if (pick) return { fromDeg: pick.windFromDeg, hourAt: pick.at };
  // No hourly data: only trust the snapshot's wind if the hunter didn't override it.
  return snap.overriddenFields.includes('windFromDeg') ? null : { fromDeg: snap.windFromDeg };
}

function worstDecision(ds: Decision[]): Decision {
  const order = { go: 0, caution: 1, no_go: 2 } as const;
  const status = ds.reduce<Decision['status']>((w, d) => (order[d.status] > order[w] ? d.status : w), 'go');
  const reasons = [...new Set(ds.filter((d) => d.status !== 'go').flatMap((d) => d.reasons))];
  return { status, reasons };
}

export default function HuntMode() {
  const t = useTheme();
  const params = useLocalSearchParams<{ standId?: string }>();
  const storePlan = useAppStore((s) => s.plan);
  const hunt = useAppStore((s) => s.hunt);
  const settings = useAppStore((s) => s.settings);
  const properties = useAppStore((s) => s.properties);
  const set = useAppStore((s) => s.set);
  const [now, setNow] = useState(Date.now());
  const [lastLog, setLastLog] = useState<string | null>(null);
  const [sessionPlan, setSessionPlan] = useState<{ plan: Plan; card: PlanCard } | null>(null);
  const [planMissing, setPlanMissing] = useState(false);
  const [live, setLive] = useState<{ snapshot: WeatherSnapshot; offline: boolean; fetchedAt: number } | null>(null);
  const [sosBusy, setSosBusy] = useState(false);
  const [armBusy, setArmBusy] = useState(false);
  const startedKey = useRef<string | null>(null);
  const ending = useRef<boolean>(false);

  const requested = params.standId;
  // The hunter asked to hunt a different stand (or a newer plan) than the active session's.
  const switching = !!(hunt && requested && storePlan && (hunt.standId !== requested || hunt.planId !== storePlan.plan.id));

  // Red light on while hunting; restore on exit.
  useEffect(() => {
    set({ redLight: true });
    return () => set({ redLight: false });
  }, [set]);

  // The active session's own plan, when it isn't the latest one in memory (replan, restart).
  const huntPlanId = hunt?.planId;
  useEffect(() => {
    if (!huntPlanId || huntPlanId === storePlan?.plan.id) return;
    let alive = true;
    void getPlan(huntPlanId)
      .then((p) => {
        if (!alive) return;
        setSessionPlan(p);
        setPlanMissing(!p);
      })
      .catch(() => alive && setPlanMissing(true));
    return () => {
      alive = false;
    };
  }, [huntPlanId, storePlan]);

  const planState = hunt && !switching ? (storePlan?.plan.id === hunt.planId ? storePlan : sessionPlan?.plan.id === hunt.planId ? sessionPlan : null) : storePlan;
  const plan = planState?.plan ?? null;
  const standId = hunt && !switching ? hunt.standId : requested;
  const recs = useMemo(() => (plan ? allRecs(plan) : []), [plan]);
  const rec = standId ? recs.find((r) => r.stand.id === standId) : undefined;
  const property = useMemo(() => properties.find((p) => p.id === (hunt?.propertyId ?? plan?.propertyId)) ?? null, [properties, hunt?.propertyId, plan]);

  const begin = useCallback(
    (p: Plan, target: StandRecommendation) => {
      const key = `${p.id}:${target.stand.id}`;
      if (startedKey.current === key) return;
      startedKey.current = key;
      const prop = properties.find((x) => x.id === p.propertyId);
      void startHunt({ plan: p, rec: target, checkInMinutes: settings.checkInMinutes, emergencyContact: settings.emergencyContact, origin: prop?.calibration?.originGeo })
        // Ask for location now, not during an emergency, and warm up a fix for the SOS text.
        .then(() => ensureLocationPermission())
        .then((ok) => (ok ? quickLocation(15_000) : null))
        .catch(() => undefined);
    },
    [properties, settings.checkInMinutes, settings.emergencyContact],
  );

  // Start a session only when the hunter picked a stand and none is active.
  useEffect(() => {
    if (hunt || ending.current || !requested || !storePlan) return;
    const target = allRecs(storePlan.plan).find((r) => r.stand.id === requested);
    if (target) begin(storePlan.plan, target);
  }, [hunt, requested, storePlan, begin]);

  // Clock tick (twice a minute is plenty and battery-friendly).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Battery-aware wind refresh for THIS hunt's property, date and window.
  const refreshWind = useCallback(async () => {
    const origin = property?.calibration?.originGeo;
    if (!plan || !property || !origin) return;
    try {
      const r = await loadForecast(origin, plan.inputs.date, plan.inputs.window, property.stateCode, plan.inputs.phaseOverride);
      setLive({ snapshot: r.snapshot, offline: r.status === 'offline', fetchedAt: Date.now() });
      // Keep the global wind badge in step, but only when it shows this same sit.
      const s = useAppStore.getState();
      if (s.activePropertyId === plan.propertyId && s.draft.date === plan.inputs.date && s.draft.window === plan.inputs.window) {
        set({ weather: r.snapshot, weatherStatus: r.status, weatherError: r.note });
      }
    } catch {
      setLive((prev) => (prev ? { ...prev, offline: true } : prev));
    }
  }, [plan, property, set]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const loop = async () => {
      await refreshWind();
      const min = await windPollMinutes();
      if (alive) timer = setTimeout(loop, min * 60_000);
    };
    void loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refreshWind]);

  // ---- No session and nothing picked: never start a hunt on a guess. -------------------
  if (!hunt) {
    const starting = !ending.current && !!(requested && storePlan && allRecs(storePlan.plan).some((r) => r.stand.id === requested));
    return (
      <Screen title="Hunt mode" onBack={() => router.back()}>
        <View style={{ padding: SPACE }}>
          <Text style={{ color: t.text, fontSize: font.md }}>
            {ending.current ? 'Ending hunt…' : starting ? 'Starting your hunt…' : storePlan ? (requested ? "That stand isn't in your latest plan." : 'No active hunt. Pick a stand from your plan to start.') : 'Make a plan first.'}
          </Text>
          {!starting && !ending.current && storePlan ? <BigButton label="Open plan" onPress={() => router.replace('/results')} /> : null}
          {!starting && !ending.current ? <BigButton label="Home" kind="secondary" onPress={() => router.replace('/')} /> : null}
        </View>
      </Screen>
    );
  }

  // ---- Asked to hunt another stand while a hunt is running: ask, don't assume. ----------
  if (switching && storePlan) {
    const target = allRecs(storePlan.plan).find((r) => r.stand.id === requested);
    return (
      <Screen title="Hunt mode" onBack={() => router.back()}>
        <View style={{ padding: SPACE }}>
          <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900' }}>You're already hunting {hunt.standName ?? 'another stand'}.</Text>
          <Text style={{ color: t.textDim, fontSize: font.md, marginTop: 6 }}>
            {hunt.checkInDueAt ? `Check-in due ${fmtTime(hunt.checkInDueAt)}. ` : ''}Starting a new hunt ends that one and restarts your check-in timer.
          </Text>
          {target ? <BigButton label={`Start hunt at ${target.stand.name}`} onPress={() => begin(storePlan.plan, target)} style={{ marginTop: SPACE }} /> : <Text style={{ color: t.text, marginTop: SPACE }}>That stand isn't in your latest plan.</Text>}
          <BigButton label={`Keep hunting ${hunt.standName ?? 'current stand'}`} kind="secondary" onPress={() => router.replace('/hunt')} />
        </View>
      </Screen>
    );
  }

  const session: HuntSession = hunt;
  const standName = rec?.stand.name ?? session.standName ?? 'Your stand';

  // ---- Live wind alert: wind at the tree / forecast for this hour vs. this stand's dial. --
  const plannedWeather = plan?.inputs.weather;
  const observedFresh = session.observedWindFromDeg !== undefined && session.observedWindAt && minutesUntil(session.observedWindAt, now) > -OBSERVED_WIND_TTL_MIN;
  const forecast = forecastWindNow(live?.snapshot ?? plannedWeather, now);
  const yourPlanned = plannedWeather && !plannedWeather.placeholder && (plannedWeather.overriddenFields.includes('windFromDeg') || plannedWeather.source === 'manual') ? plannedWeather.windFromDeg : undefined;
  const winds: Array<{ key: string; label: string; fromDeg: number; status: DialStatus }> = [];
  if (rec) {
    if (observedFresh) winds.push({ key: 'observed', label: `Your wind (${fmtTime(session.observedWindAt as string)})`, fromDeg: session.observedWindFromDeg as number, status: dialStatus(rec, session.observedWindFromDeg as number) });
    else if (yourPlanned !== undefined) winds.push({ key: 'planned', label: 'Your wind when planning', fromDeg: yourPlanned, status: dialStatus(rec, yourPlanned) });
    if (forecast) {
      const age = !live ? ' (from your plan)' : live.offline ? ' (offline, last download)' : '';
      winds.push({ key: 'forecast', label: `NWS ${forecast.hourAt ? `${fmtTime(forecast.hourAt)} hour` : 'forecast'}${age}`, fromDeg: forecast.fromDeg, status: dialStatus(rec, forecast.fromDeg) });
    }
    if (!winds.length && plannedWeather) winds.push({ key: 'plan', label: 'Plan wind', fromDeg: plannedWeather.windFromDeg, status: dialStatus(rec, plannedWeather.windFromDeg) });
  }
  // Observed wind outranks the forecast; a bad forecast still earns a caution.
  let windHead: DialStatus = winds.reduce<DialStatus>((w, x) => (RANK[x.status] > RANK[w] ? x.status : w), 'good');
  if (observedFresh && winds[0]) windHead = winds[0].status === 'good' && winds.some((w) => w.status === 'bad') ? 'caution' : winds[0].status;
  const windBad = windHead === 'bad';
  const windCaution = windHead === 'caution';

  // ---- Check-in ----------------------------------------------------------------------
  const dueIn = session.checkInDueAt ? minutesUntil(session.checkInDueAt, now) : null;
  const overdue = dueIn !== null && dueIn < -OVERDUE_GRACE_MIN;
  const notArmed = session.checkInArmed === false;
  const arming = session.checkInArmed === undefined;

  // ---- Legal light: not yet / legal / ended ------------------------------------------
  const legalStart = plan ? minutesUntil(plan.legal.start, now) : null;
  const legalEnd = plan ? minutesUntil(plan.legal.end, now) : null;

  const decision = plan && rec ? worstDecision([plan.weatherDecision, rec.decision]) : null;

  const logSighting = async (m: Maturity) => {
    tap(settings.haptics);
    const s: Sighting = {
      id: uid('sight'),
      propertyId: session.propertyId,
      huntId: session.huntId,
      at: new Date().toISOString(),
      position: rec?.stand.position ?? session.standPosition,
      maturity: m,
      count: 1,
      behavior: 'unknown',
      source: 'observed',
    };
    try {
      await saveSighting(s);
      setLastLog(`${SIGHTINGS.find((x) => x.m === m)?.label} logged ${fmtTime(s.at)}`);
    } catch {
      setLastLog('Could not save that sighting. Try again.');
    }
  };

  const checkIn = async (dueIso: string) => {
    tap(settings.haptics);
    setArmBusy(true);
    try {
      await resetCheckIn(dueIso);
    } finally {
      setArmBusy(false);
    }
  };
  const minutesFromNow = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const retryArm = () => void checkIn(session.checkInDueAt && Date.parse(session.checkInDueAt) > Date.now() + 60_000 ? session.checkInDueAt : minutesFromNow(settings.checkInMinutes));

  const sos = async () => {
    const contact = settings.emergencyContact;
    if (!contact.phone) {
      Alert.alert('No emergency contact', 'Add one in Settings. If you need help now, call 911.');
      return;
    }
    setSosBusy(true);
    try {
      // Never wait on GPS for more than a few seconds: the composer must open.
      const fix = await quickLocation(4_000);
      const stale = fix && Date.now() - Date.parse(fix.at) > 5 * 60_000;
      const msg = emergencyMessage(contact.name, standName, property?.name ?? 'my property', fix?.point ?? null, { fixAt: stale ? fix?.at : undefined, standGeo: session.standGeo });
      const ok = await textEmergencyContact(contact.phone, msg);
      if (!ok) Alert.alert('Could not open messages', `Call ${contact.name || contact.phone} directly, or 911.`);
    } finally {
      setSosBusy(false);
    }
  };

  const endHunt = async () => {
    ending.current = true;
    await endActiveHunt();
    router.replace('/log');
  };

  const statusColor = (s: DialStatus) => (s === 'bad' ? t.status.avoid : s === 'caution' ? t.status.caution : t.status.safe);
  const statusIcon = (s: DialStatus) => (s === 'bad' ? 'avoid' : s === 'caution' ? 'caution' : 'safe');

  return (
    <Screen title={standName} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 40 }}>
        {/* Check-in reminders OFF: loud, first, and fixable from here. */}
        {notArmed ? (
          <View style={{ borderRadius: RADIUS, borderWidth: 3, borderColor: t.status.avoid, padding: 12, marginBottom: SPACE }} accessibilityLiveRegion="assertive">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <StatusIcon status="avoid" color={t.status.avoid} size={34} />
              <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900', flex: 1 }}>CHECK-IN REMINDERS ARE OFF</Text>
            </View>
            <Text style={{ color: t.text, fontSize: font.md, marginTop: 6 }}>{session.checkInProblem ?? 'No reminder is scheduled.'} Nothing will remind you or prompt you to text your contact.</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <BigButton label="Open Settings" kind="danger" onPress={() => void openAppSettings()} style={{ flex: 1 }} />
              <BigButton label="Try again" kind="secondary" loading={armBusy} onPress={retryArm} style={{ flex: 1 }} />
            </View>
          </View>
        ) : null}

        {planMissing && !rec ? (
          <Text style={{ color: t.status.caution, fontSize: font.md, marginBottom: 8 }}>! This hunt's plan is no longer saved, so the wind check is off. The check-in timer and emergency text still work.</Text>
        ) : null}

        {/* Go / no-go for this stand today */}
        {decision && decision.status !== 'go' ? (
          <View style={{ borderRadius: RADIUS, borderWidth: 2, borderColor: decision.status === 'no_go' ? t.status.avoid : t.status.caution, padding: 12, marginBottom: SPACE }}>
            <StatusChip status={decision.status} label={decision.status === 'no_go' ? 'NO-GO TODAY' : 'CAUTION'} />
            {decision.reasons.slice(0, 3).map((r, i) => (
              <Text key={i} style={{ color: t.text, fontSize: font.md, marginTop: 4 }}>
                • {r}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Live wind alert */}
        {rec ? (
          <View style={{ borderRadius: RADIUS, borderWidth: 2, borderColor: windBad ? t.status.avoid : t.border, padding: 12 }} accessibilityLiveRegion="polite">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <StatusIcon status={statusIcon(windHead)} color={statusColor(windHead)} size={34} />
              <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900', flex: 1 }}>{windBad ? 'WIND SWITCHED: BAD HERE' : windCaution ? 'Wind on the edge' : 'Wind good'}</Text>
            </View>
            {winds.map((w) => (
              <View key={w.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <StatusIcon status={statusIcon(w.status)} color={statusColor(w.status)} size={18} />
                <Text style={{ color: t.textDim, fontSize: font.md, flex: 1 }}>
                  {w.label}: {compass16(w.fromDeg)}, scent to {compass16(downwindBearing(w.fromDeg))}
                </Text>
              </View>
            ))}
            {rec.assumedWindFromDeg !== undefined ? <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 4 }}>This backup is for a wind from {compass16(rec.assumedWindFromDeg)}.</Text> : null}
            {windBad ? <Text style={{ color: t.text, fontSize: font.md, marginTop: 4 }}>Scent is reaching deer. Consider backing out on your exit route.</Text> : null}
            <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 8 }}>Wind at your tree? Tap where it's coming FROM:</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {WIND_DIRS.map((d) => {
                const on = observedFresh && session.observedWindFromDeg === d;
                return (
                  <Pressable
                    key={d}
                    accessibilityRole="button"
                    accessibilityState={{ selected: !!on }}
                    accessibilityLabel={`Wind from ${compass16(d)}`}
                    onPress={() => {
                      tap(settings.haptics);
                      void setObservedWind(on ? null : d);
                    }}
                    style={{ width: '23%', minHeight: TOUCH, borderRadius: RADIUS, borderWidth: on ? 2 : 1, borderColor: on ? t.accent : t.border, backgroundColor: on ? t.surfaceAlt : t.surface, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>{compass16(d)}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {plan && legalStart !== null && legalEnd !== null ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <StatusIcon status={legalStart > 0 || legalEnd <= 0 ? 'avoid' : legalEnd <= 15 ? 'caution' : 'safe'} color={legalStart > 0 || legalEnd <= 0 ? t.status.avoid : legalEnd <= 15 ? t.status.caution : t.status.safe} size={22} />
            <Text style={{ color: t.text, fontSize: font.md, fontWeight: '700', flex: 1 }}>
              {legalStart > 0
                ? `NOT LEGAL until ${fmtTime(plan.legal.start)} (in ${fmtDuration(legalStart)})`
                : legalEnd > 0
                  ? `Legal light until ${fmtTime(plan.legal.end)} (${fmtDuration(legalEnd)} left)`
                  : `Legal light ended ${fmtTime(plan.legal.end)}: no shots`}
            </Text>
          </View>
        ) : null}
        {plan ? <Text style={{ color: t.textDim, fontSize: font.xs }}>Shooting hours: {plan.legal.rule}</Text> : null}

        {/* One-tap sighting log */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: SPACE }}>
          {SIGHTINGS.map((s) => (
            <Pressable
              key={s.m}
              accessibilityRole="button"
              accessibilityLabel={`Log ${s.label}`}
              onPress={() => void logSighting(s.m)}
              style={{ width: '48%', minHeight: TOUCH + 28, borderRadius: RADIUS, borderWidth: s.m === 'mature_buck' ? 2 : 1, borderColor: s.m === 'mature_buck' ? t.accent : t.border, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900' }}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
        {lastLog ? <Text style={{ color: t.textDim, marginTop: 6 }}>✓ {lastLog}</Text> : null}

        {/* Check-in timer */}
        <View style={{ marginTop: SPACE, borderRadius: RADIUS, borderWidth: 2, borderColor: overdue || notArmed ? t.status.avoid : t.border, padding: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusIcon status={overdue || notArmed ? 'avoid' : dueIn !== null && dueIn <= 0 ? 'caution' : 'safe'} color={overdue || notArmed ? t.status.avoid : dueIn !== null && dueIn <= 0 ? t.status.caution : t.status.safe} size={24} />
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900', flex: 1 }}>
              {dueIn === null ? 'Check-in not set' : overdue ? 'OVERDUE' : dueIn <= 0 ? 'Check in now' : `Check in within ${fmtDuration(dueIn)}`}
            </Text>
          </View>
          <Text style={{ color: notArmed ? t.status.avoid : t.textDim, fontSize: font.sm }}>
            {notArmed ? 'No reminder will fire. ' : arming ? 'Setting reminders… ' : ''}
            {settings.emergencyContact.phone ? `Contact: ${settings.emergencyContact.name || settings.emergencyContact.phone}` : 'No emergency contact set (Settings)'}.{' '}
            {isAndroid ? 'Reminders vibrate only.' : 'Reminders use the iPhone alert: with the ring switch on silent they only vibrate.'} Phones can't auto-text, so if you're overdue, tap below.
          </Text>
          {isAndroid && androidApiLevel >= 31 ? (
            <Text style={{ color: t.textDim, fontSize: font.xs, marginTop: 2 }}>Android can delay reminders unless "Alarms & reminders" is allowed for Stand Planner (Settings › Safety).</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <BigButton label="I'm safe" disabled={armBusy} onPress={() => void checkIn(minutesFromNow(settings.checkInMinutes))} style={{ flex: 1 }} />
            <BigButton label="+30 min" kind="secondary" disabled={armBusy} onPress={() => void checkIn(minutesFromNow(Math.max(30, (dueIn ?? 0) + 30)))} style={{ flex: 1 }} />
          </View>
          <BigButton label="Text emergency contact" kind="danger" loading={sosBusy} onPress={() => void sos()} />
        </View>

        <Text style={{ color: t.text, fontSize: font.md, fontWeight: '900', marginTop: SPACE }}>HARNESS ON. Connected ground to ground.</Text>
        {rec ? <Text style={{ color: t.textDim, fontSize: font.sm }}>Exit: {rec.exitRoute ? `${rec.exitRoute.startLabel}. ${rec.exitRoute.notes[0] ?? ''}` : 'no route mapped'}</Text> : null}

        <BigButton label="End hunt & log" kind="secondary" onPress={() => void endHunt()} style={{ marginTop: SPACE }} />
      </ScrollView>
    </Screen>
  );
}

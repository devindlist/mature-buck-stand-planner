import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { compass16, downwindBearing, type Maturity, type Sighting } from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Screen } from '../src/components/ui';
import { StatusIcon } from '../src/components/Icons';
import { saveHunt, savePressure, saveSighting } from '../src/db/repos';
import { armCheckIn, cancelCheckIn, emergencyMessage, OVERDUE_GRACE_MIN, textEmergencyContact } from '../src/services/checkin';
import { currentLocation, tap, windPollMinutes } from '../src/services/device';
import { loadForecast } from '../src/services/weather';
import { fmtDuration, fmtTime, minutesUntil, uid } from '../src/utils/format';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Hunt mode: red-light, minimal, silent. Live wind check against the stand's dial,
 * one-tap sighting log, and the safety check-in timer.
 */
const SIGHTINGS: Array<{ m: Maturity; label: string }> = [
  { m: 'mature_buck', label: 'MATURE BUCK' },
  { m: 'young_buck', label: 'Young buck' },
  { m: 'doe', label: 'Doe(s)' },
  { m: 'unknown', label: 'Other deer' },
];

export default function HuntMode() {
  const t = useTheme();
  const params = useLocalSearchParams<{ standId?: string }>();
  const planState = useAppStore((s) => s.plan);
  const hunt = useAppStore((s) => s.hunt);
  const settings = useAppStore((s) => s.settings);
  const weather = useAppStore((s) => s.weather);
  const set = useAppStore((s) => s.set);
  const property = useAppStore((s) => s.properties.find((p) => p.id === s.plan?.plan.propertyId) ?? null);
  const [now, setNow] = useState(Date.now());
  const [lastLog, setLastLog] = useState<string | null>(null);
  const overrideFrom = useAppStore((s) => s.draft.overrides.windFromDeg);

  const recs = useMemo(() => (planState ? [...planState.plan.recommendations, ...(planState.plan.backup ? [planState.plan.backup] : []), ...(planState.plan.yourStands ?? [])] : []), [planState]);
  const rec = recs.find((r) => r.stand.id === (params.standId ?? hunt?.standId)) ?? recs[0];

  // Red light on while hunting; restore on exit.
  useEffect(() => {
    set({ redLight: true });
    return () => set({ redLight: false });
  }, [set]);

  // Start (or resume) the hunt session and arm the check-in.
  useEffect(() => {
    if (!planState || !rec || hunt) return;
    const started = new Date().toISOString();
    const due = new Date(Date.now() + settings.checkInMinutes * 60_000).toISOString();
    const session = { huntId: uid('hunt'), planId: planState.plan.id, propertyId: planState.plan.propertyId, standId: rec.stand.id, startedAt: started, checkInDueAt: due };
    set({ hunt: session });
    void armCheckIn(due, rec.stand.name).then((ids) => {
      const cur = useAppStore.getState().hunt;
      if (cur?.huntId === session.huntId) set({ hunt: { ...cur, checkInNotificationIds: ids } });
    });
    void saveHunt({ id: session.huntId, propertyId: session.propertyId, planId: session.planId, standId: session.standId, date: planState.plan.inputs.date, window: planState.plan.inputs.window, startedAt: started, checkIn: { expectedBackAt: due, emergencyContactName: settings.emergencyContact.name, emergencyContactPhone: settings.emergencyContact.phone, status: 'armed' } });
  }, [planState, rec, hunt, settings.checkInMinutes, settings.emergencyContact, set]);

  // Clock tick (once a minute is plenty and battery-friendly).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Battery-aware wind refresh.
  const refreshWind = useCallback(async () => {
    if (!planState || !property?.calibration?.originGeo) return;
    try {
      const r = await loadForecast(property.calibration.originGeo, planState.plan.inputs.date, planState.plan.inputs.window, property.stateCode);
      set({ weather: r.snapshot });
    } catch {
      /* stay on last known wind */
    }
  }, [planState, property, set]);
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

  if (!planState || !rec) {
    return (
      <Screen title="Hunt mode" onBack={() => router.back()}>
        <View style={{ padding: SPACE }}>
          <Text style={{ color: t.text }}>Make a plan first.</Text>
        </View>
      </Screen>
    );
  }

  // Live wind alert: current wind vs. this stand's dial.
  const windFrom = overrideFrom ?? weather?.windFromDeg ?? planState.plan.inputs.weather.windFromDeg;
  const sector = rec.windDial.sectors[Math.round((((windFrom % 360) + 360) % 360) / 22.5) % 16];
  const windBad = sector.status === 'bad';
  const windCaution = sector.status === 'caution';

  const dueIn = hunt?.checkInDueAt ? minutesUntil(hunt.checkInDueAt, now) : null;
  const overdue = dueIn !== null && dueIn < -OVERDUE_GRACE_MIN;
  const legalEnd = minutesUntil(planState.plan.legal.end, now);

  const logSighting = async (m: Maturity) => {
    tap(settings.haptics);
    const s: Sighting = {
      id: uid('sight'),
      propertyId: planState.plan.propertyId,
      huntId: hunt?.huntId,
      at: new Date().toISOString(),
      position: rec.stand.position,
      maturity: m,
      count: 1,
      behavior: 'unknown',
      source: 'observed',
    };
    await saveSighting(s);
    setLastLog(`${SIGHTINGS.find((x) => x.m === m)?.label} logged ${fmtTime(s.at)}`);
  };

  const checkIn = async (extendMin: number) => {
    if (!hunt) return;
    await cancelCheckIn(hunt.checkInNotificationIds);
    const due = new Date(Date.now() + extendMin * 60_000).toISOString();
    const ids = await armCheckIn(due, rec.stand.name);
    set({ hunt: { ...hunt, checkInDueAt: due, checkInNotificationIds: ids } });
  };

  const sos = async () => {
    const gps = await currentLocation().catch(() => null);
    const ok = await textEmergencyContact(settings.emergencyContact.phone, emergencyMessage(settings.emergencyContact.name, rec.stand.name, property?.name ?? 'my property', gps));
    if (!ok) Alert.alert('Could not open messages', settings.emergencyContact.phone ? 'Call your contact directly.' : 'Add an emergency contact in Settings.');
  };

  const endHunt = async () => {
    await cancelCheckIn(hunt?.checkInNotificationIds);
    if (hunt) {
      await savePressure({ id: uid('press'), propertyId: hunt.propertyId, at: hunt.startedAt, kind: 'sit', standId: rec.stand.id, position: rec.stand.position });
    }
    router.replace('/log');
  };

  return (
    <Screen title={rec.stand.name} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 40 }}>
        {/* Live wind alert */}
        <View style={{ borderRadius: RADIUS, borderWidth: 2, borderColor: windBad ? t.status.avoid : t.border, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }} accessibilityLiveRegion="polite">
          <StatusIcon status={windBad ? 'avoid' : windCaution ? 'caution' : 'safe'} color={windBad ? t.status.avoid : windCaution ? t.status.caution : t.status.safe} size={34} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900' }}>
              {windBad ? 'WIND SWITCHED: BAD HERE' : windCaution ? 'Wind on the edge' : 'Wind good'}
            </Text>
            <Text style={{ color: t.textDim, fontSize: font.md }}>
              {compass16(windFrom)}, scent to {compass16(downwindBearing(windFrom))}
              {windBad ? '. Scent is reaching deer. Consider backing out on your exit route.' : ''}
            </Text>
          </View>
        </View>

        <Text style={{ color: t.textDim, fontSize: font.md, marginTop: 8 }}>
          Legal light ends {fmtTime(planState.plan.legal.end)} ({legalEnd > 0 ? `${fmtDuration(legalEnd)} left` : 'ended: no shots'})
        </Text>

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
        <View style={{ marginTop: SPACE, borderRadius: RADIUS, borderWidth: 2, borderColor: overdue ? t.status.avoid : t.border, padding: 12 }}>
          <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900' }}>
            {dueIn === null ? 'Check-in not set' : overdue ? 'OVERDUE' : dueIn <= 0 ? 'Check in now' : `Check in within ${fmtDuration(dueIn)}`}
          </Text>
          <Text style={{ color: t.textDim, fontSize: font.sm }}>
            {settings.emergencyContact.phone ? `Contact: ${settings.emergencyContact.name || settings.emergencyContact.phone}` : 'No emergency contact set (Settings)'}. Reminders vibrate only; phones can't auto-text, so if you're overdue, tap below.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <BigButton label="I'm safe" onPress={() => void checkIn(settings.checkInMinutes)} style={{ flex: 1 }} />
            <BigButton label="+30 min" kind="secondary" onPress={() => void checkIn(Math.max(30, (dueIn ?? 0) + 30))} style={{ flex: 1 }} />
          </View>
          <BigButton label="Text emergency contact" kind="danger" onPress={() => void sos()} />
        </View>

        <Text style={{ color: t.text, fontSize: font.md, fontWeight: '900', marginTop: SPACE }}>HARNESS ON. Connected ground to ground.</Text>
        <Text style={{ color: t.textDim, fontSize: font.sm }}>Exit: {rec.exitRoute ? `${rec.exitRoute.startLabel}. ${rec.exitRoute.notes[0] ?? ''}` : 'no route mapped'}</Text>

        <BigButton label="End hunt & log" kind="secondary" onPress={() => void endHunt()} style={{ marginTop: SPACE }} />
      </ScrollView>
    </Screen>
  );
}

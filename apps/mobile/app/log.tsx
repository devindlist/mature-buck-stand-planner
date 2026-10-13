import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { Hunt, HuntOutcome, HuntWindow, Vec } from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Label, Screen } from '../src/components/ui';
import { getHunt, saveHunt, savePressure } from '../src/db/repos';
import { endActiveHunt } from '../src/services/huntSession';
import { todayLocal, uid } from '../src/utils/format';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Post-hunt log in under 60 seconds: one tap for the outcome, two toggles,
 * and notes by voice using the keyboard's mic (on-device dictation, no extra permission).
 *
 * Logs the running hunt (saving ends it and cancels its check-in alarms), or the one just
 * ended in Hunt mode. With no session it's an unplanned sit: today's date, and pressure is
 * recorded only at the stand the hunter picks, never at a guess.
 */
const OUTCOMES: Array<{ k: HuntOutcome; label: string }> = [
  { k: 'mature_buck_seen', label: 'Saw mature buck' },
  { k: 'mature_buck_harvested', label: 'Harvested!' },
  { k: 'young_bucks', label: 'Young bucks' },
  { k: 'does_only', label: 'Does only' },
  { k: 'no_deer', label: 'No deer' },
  { k: 'bumped_deer', label: 'Bumped deer' },
];

/** An ended-but-unlogged hunt older than this is not assumed to be the one being logged. */
const ENDED_HUNT_MAX_AGE_MS = 12 * 3_600_000;

const windowAt = (d: Date): HuntWindow => (d.getHours() < 12 ? 'AM' : 'PM');

export default function Log() {
  const t = useTheme();
  const active = useAppStore((s) => s.hunt);
  const ended = useAppStore((s) => s.endedHunt);
  const planState = useAppStore((s) => s.plan);
  const properties = useAppStore((s) => s.properties);
  const activeProperty = useAppStore((s) => s.activeProperty());
  const set = useAppStore((s) => s.set);
  const [outcome, setOutcome] = useState<HuntOutcome | null>(null);
  const [bumpedIn, setBumpedIn] = useState(false);
  const [bumpedOut, setBumpedOut] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [pickedStandId, setPickedStandId] = useState<string | null>(null);

  const recentEnded = ended?.endedAt && Date.now() - Date.parse(ended.endedAt) < ENDED_HUNT_MAX_AGE_MS ? ended : null;
  const session = active ?? recentEnded;
  const property = (session ? properties.find((p) => p.id === session.propertyId) : undefined) ?? activeProperty;
  const plan = planState?.plan ?? null;
  const sessionPlan = session && plan?.id === session.planId ? plan : null;
  // Without a session, the latest plan counts only if it's for this property and today.
  const todaysPlan = !session && plan && plan.propertyId === property?.id && plan.inputs.date === todayLocal() ? plan : null;

  // Stands the hunter can pick when logging a sit without Hunt mode.
  const standChoices = useMemo(() => {
    const m = new Map<string, { id: string; name: string; position: Vec }>();
    for (const s of property?.stands ?? []) if (!s.dismissed) m.set(s.id, { id: s.id, name: s.name, position: s.position });
    if (plan && plan.propertyId === property?.id) {
      for (const r of [...plan.recommendations, ...(plan.backup ? [plan.backup] : []), ...(plan.yourStands ?? [])]) m.set(r.stand.id, { id: r.stand.id, name: r.stand.name, position: r.stand.position });
    }
    return [...m.values()];
  }, [property, plan]);

  const save = async () => {
    const propertyId = session?.propertyId ?? property?.id;
    if (!propertyId || !outcome) return;
    setSaving(true);
    try {
      // Logging a running hunt ends it: alarms cancelled, sit recorded.
      if (active) await endActiveHunt();
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const started = session?.startedAt ? new Date(session.startedAt) : nowDate;
      const prev = session ? await getHunt(session.huntId) : null;
      const hunt: Hunt = {
        ...(prev ?? {}),
        id: session?.huntId ?? uid('hunt'),
        propertyId,
        planId: session?.planId ?? todaysPlan?.id,
        standId: session?.standId ?? pickedStandId ?? undefined,
        date: sessionPlan?.inputs.date ?? todaysPlan?.inputs.date ?? todayLocal(started),
        window: sessionPlan?.inputs.window ?? todaysPlan?.inputs.window ?? windowAt(started),
        startedAt: session?.startedAt,
        endedAt: session?.endedAt ?? now,
        outcome,
        bumpedDeerOnEntry: bumpedIn,
        bumpedDeerOnExit: bumpedOut,
        notes: notes.trim() || undefined,
        checkIn: session?.checkInDueAt ? { ...(prev?.checkIn ?? {}), expectedBackAt: session.checkInDueAt, status: 'checked_in' } : prev?.checkIn,
      };
      await saveHunt(hunt);
      // Bumps are pressure history: the planner steers away for a week. Only at the stand
      // actually sat (the session's, or the one picked here); never at a stand not sat.
      const picked = standChoices.find((s) => s.id === pickedStandId);
      const standId = session?.standId ?? picked?.id;
      const position = session ? (session.standPosition ?? standChoices.find((s) => s.id === session.standId)?.position) : picked?.position;
      if (bumpedIn || bumpedOut || outcome === 'bumped_deer') {
        await savePressure({ id: uid('press'), propertyId, at: now, kind: 'bumped_deer', standId, position, note: bumpedIn ? 'on entry' : bumpedOut ? 'on exit' : 'during sit' });
      }
      // Hunt-mode sits were recorded when the hunt ended.
      if (!session && picked) await savePressure({ id: uid('press'), propertyId, at: now, kind: 'sit', standId: picked.id, position: picked.position });
      set({ endedHunt: null });
      router.replace('/');
    } catch (e) {
      Alert.alert('Could not save the log', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (on: boolean, label: string, onPress: () => void) => (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} onPress={onPress} style={{ flex: 1, minHeight: TOUCH, borderRadius: RADIUS, borderWidth: 1.5, borderColor: on ? t.accent : t.border, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.surfaceAlt : 'transparent' }}>
      <Text style={{ color: t.text, fontWeight: '800' }}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Screen title="Log hunt" onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: t.textDim, fontSize: font.sm }}>
          {session ? `${session.standName ?? 'Your stand'}${property ? ` · ${property.name}` : ''}` : property ? `Unplanned sit · ${property.name} · today` : ''}
        </Text>
        {active ? <Text style={{ color: t.status.caution, fontSize: font.sm, marginTop: 4 }}>! Saving ends your active hunt and cancels its check-in reminders.</Text> : null}

        <Label>HOW DID IT GO?</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {OUTCOMES.map((o) => (
            <Pressable
              key={o.k}
              accessibilityRole="radio"
              accessibilityState={{ selected: outcome === o.k }}
              onPress={() => setOutcome(o.k)}
              style={{ width: '48%', minHeight: TOUCH + 12, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: outcome === o.k ? t.accent : t.surface, borderWidth: 1, borderColor: t.border }}
            >
              <Text style={{ color: outcome === o.k ? t.accentText : t.text, fontWeight: '800', fontSize: font.md }}>{o.label}</Text>
            </Pressable>
          ))}
        </View>

        {!session && standChoices.length ? (
          <>
            <Label>WHICH STAND? (OPTIONAL)</Label>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {standChoices.map((s) => {
                const on = pickedStandId === s.id;
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setPickedStandId(on ? null : s.id)}
                    style={{ minHeight: TOUCH, paddingHorizontal: 14, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.accent : t.surface, borderWidth: 1, borderColor: on ? t.accent : t.border }}
                  >
                    <Text style={{ color: on ? t.accentText : t.text, fontWeight: '800', fontSize: font.md }}>
                      {on ? '✓ ' : ''}
                      {s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}

        <Label>BUMPED DEER?</Label>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {toggle(bumpedIn, 'On entry', () => setBumpedIn((v) => !v))}
          {toggle(bumpedOut, 'On exit', () => setBumpedOut((v) => !v))}
        </View>

        <Label>NOTES · TAP THE KEYBOARD MIC TO DICTATE</Label>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Where he came from, time, wind at the tree…"
          placeholderTextColor={t.textDim}
          style={{ minHeight: 120, borderRadius: RADIUS, borderWidth: 1, borderColor: t.border, backgroundColor: t.surfaceAlt, color: t.text, padding: 12, fontSize: font.md, textAlignVertical: 'top' }}
        />

        <BigButton label="Save log" disabled={!outcome} loading={saving} onPress={() => void save()} style={{ marginTop: SPACE, minHeight: 64 }} />
      </ScrollView>
    </Screen>
  );
}

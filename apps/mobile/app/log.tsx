import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { Hunt, HuntOutcome } from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Label, Screen } from '../src/components/ui';
import { saveHunt, savePressure } from '../src/db/repos';
import { todayLocal, uid } from '../src/utils/format';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Post-hunt log in under 60 seconds: one tap for the outcome, two toggles,
 * and notes by voice using the keyboard's mic (on-device dictation, no extra permission).
 */
const OUTCOMES: Array<{ k: HuntOutcome; label: string }> = [
  { k: 'mature_buck_seen', label: 'Saw mature buck' },
  { k: 'mature_buck_harvested', label: 'Harvested!' },
  { k: 'young_bucks', label: 'Young bucks' },
  { k: 'does_only', label: 'Does only' },
  { k: 'no_deer', label: 'No deer' },
  { k: 'bumped_deer', label: 'Bumped deer' },
];

export default function Log() {
  const t = useTheme();
  const session = useAppStore((s) => s.hunt);
  const planState = useAppStore((s) => s.plan);
  const property = useAppStore((s) => s.activeProperty());
  const set = useAppStore((s) => s.set);
  const [outcome, setOutcome] = useState<HuntOutcome | null>(null);
  const [bumpedIn, setBumpedIn] = useState(false);
  const [bumpedOut, setBumpedOut] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const propertyId = session?.propertyId ?? property?.id;
    if (!propertyId || !outcome) return;
    setSaving(true);
    const now = new Date().toISOString();
    const hunt: Hunt = {
      id: session?.huntId ?? uid('hunt'),
      propertyId,
      planId: session?.planId ?? planState?.plan.id,
      standId: session?.standId,
      date: planState?.plan.inputs.date ?? todayLocal(),
      window: planState?.plan.inputs.window ?? (new Date().getHours() < 12 ? 'AM' : 'PM'),
      startedAt: session?.startedAt,
      endedAt: now,
      outcome,
      bumpedDeerOnEntry: bumpedIn,
      bumpedDeerOnExit: bumpedOut,
      notes: notes.trim() || undefined,
      checkIn: session?.checkInDueAt ? { expectedBackAt: session.checkInDueAt, status: 'checked_in' } : undefined,
    };
    await saveHunt(hunt);
    // Bumps are pressure history: the planner will steer away for a week.
    const stand = planState?.plan.recommendations.find((r) => r.stand.id === session?.standId) ?? planState?.plan.backup;
    if (bumpedIn || bumpedOut || outcome === 'bumped_deer') {
      await savePressure({ id: uid('press'), propertyId, at: now, kind: 'bumped_deer', standId: session?.standId, position: stand?.stand.position, note: bumpedIn ? 'on entry' : bumpedOut ? 'on exit' : 'during sit' });
    }
    if (!session) await savePressure({ id: uid('press'), propertyId, at: now, kind: 'sit', standId: stand?.stand.id, position: stand?.stand.position });
    set({ hunt: null });
    setSaving(false);
    router.replace('/');
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

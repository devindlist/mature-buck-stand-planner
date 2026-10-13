import React from 'react';
import { Alert, ScrollView, Share, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { planCardText } from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Disclaimer, Label, Screen, StatusChip } from '../src/components/ui';
import { font, RADIUS, SPACE } from '../src/theme/theme';

/**
 * Offline plan card: the whole plan as large text, stored with the plan in the
 * encrypted database. No map, no network. Sharing is opt-in (Settings) and always
 * a deliberate tap.
 */
export default function PlanCardScreen() {
  const t = useTheme();
  const planState = useAppStore((s) => s.plan);
  const shareOptIn = useAppStore((s) => s.settings.shareOptIn);
  const selectedStandId = useAppStore((s) => s.selectedStandId);
  if (!planState) return <Redirect href="/" />;
  const card = planState.card;
  const plan = planState.plan;

  // Hunt the stand the hunter picked on Results (else the #1), under the same go/no-go rules.
  const huntable = [...plan.recommendations, ...(plan.backup ? [plan.backup] : []), ...(plan.yourStands ?? [])];
  const target = huntable.find((r) => r.stand.id === selectedStandId) ?? huntable[0];
  const noGoReasons = target ? [...new Set([plan.weatherDecision, target.decision].filter((d) => d.status === 'no_go').flatMap((d) => d.reasons))] : [];
  const noGo = !!target && (plan.weatherDecision.status === 'no_go' || target.decision.status === 'no_go');
  const startHunt = () => {
    if (!target) return;
    const go = () => router.push({ pathname: '/hunt', params: { standId: target.stand.id } });
    if (!noGo) return go();
    // Never override the hunter, but never let a no-go slip by unread either.
    Alert.alert(`NO-GO at ${target.stand.name} today`, noGoReasons.join('\n') || 'Conditions make this sit a no-go.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'I understand, start anyway', style: 'destructive', onPress: go },
    ]);
  };

  const share = async () => {
    if (!shareOptIn) {
      Alert.alert('Sharing is off', 'Plans never leave your phone unless you turn on sharing in Settings.', [
        { text: 'OK', style: 'cancel' },
        { text: 'Settings', onPress: () => router.push('/settings') },
      ]);
      return;
    }
    await Share.share({ message: planCardText(card) });
  };

  return (
    <Screen title="Plan card" onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }}>
        <Text style={{ color: t.text, fontSize: font.xl, fontWeight: '900' }}>{card.title}</Text>
        <Text style={{ color: t.textDim, fontSize: font.md }}>
          {card.dateLine} · {card.phase}
        </Text>
        <View style={{ marginTop: 8, padding: 12, borderRadius: RADIUS, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border }}>
          <Row k="Legal light" v={card.legalHours} />
          <Row k="Sun" v={card.sunLine} />
          <Row k="Wind" v={card.windLine} />
          <Row k="Weather" v={card.weatherLine} />
          <View style={{ marginTop: 6 }}>
            <StatusChip status={card.weatherStatus} label={`WEATHER ${card.weatherStatus.replace('_', '-').toUpperCase()}`} />
          </View>
        </View>

        {card.warnings.map((w, i) => (
          <Text key={i} style={{ color: t.status.caution, fontSize: font.md, marginTop: 6 }}>
            ! {w}
          </Text>
        ))}

        {card.stands.map((s) => (
          <View key={`${s.rank}-${s.name}`} style={{ marginTop: SPACE, padding: 12, borderRadius: RADIUS, borderWidth: 1.5, borderColor: s.isBackup ? t.textDim : t.accent, backgroundColor: t.surface }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '900', flex: 1 }}>
                {s.isBackup ? 'BACKUP' : s.yours ? 'YOUR STAND' : `#${s.rank}`} {s.name}
              </Text>
              <Text style={{ color: t.text, fontSize: font.xl, fontWeight: '900' }}>{s.score}</Text>
            </View>
            <StatusChip status={s.status} />
            {s.backupNote ? <Text style={{ color: t.accent, fontSize: font.md, marginTop: 4 }}>{s.backupNote}</Text> : null}
            <Text style={{ color: t.text, fontSize: font.md, marginTop: 6 }}>{s.reason}</Text>
            <Row k="Sit" v={s.sitWindow} />
            <Row k="Good winds" v={s.goodWinds} />
            <Row k="Bad winds" v={s.badWinds} />
            <Row k="In" v={s.entry} />
            <Row k="Out" v={s.exit} />
            <Row k="Shot" v={s.shot} />
            {s.risks.map((r, i) => (
              <Text key={i} style={{ color: t.status.caution, fontSize: font.md }}>
                ! {r}
              </Text>
            ))}
            <Text style={{ color: t.textDim, fontSize: font.sm }}>Confidence {s.confidence}</Text>
          </View>
        ))}

        <View style={{ marginTop: SPACE, padding: 12, borderRadius: RADIUS, borderWidth: 2, borderColor: t.accent }}>
          <Text style={{ color: t.accent, fontSize: font.lg, fontWeight: '900' }}>{card.harness}</Text>
        </View>

        {card.lowConfidence.length ? <Label>LOW-CONFIDENCE MODIFIERS</Label> : null}
        {card.lowConfidence.map((l, i) => (
          <Text key={i} style={{ color: t.textDim, fontSize: font.sm }}>
            ? {l}
          </Text>
        ))}

        <Label>REMINDERS</Label>
        {card.reminders.map((r, i) => (
          <Text key={i} style={{ color: t.text, fontSize: font.sm, marginBottom: 4 }}>
            • {r}
          </Text>
        ))}
        <Disclaimer text={card.disclaimer} />

        <BigButton label={shareOptIn ? 'Share plan (text)' : 'Share (off in Settings)'} kind="secondary" onPress={share} />
        <BigButton
          label="Start Hunt mode"
          kind={noGo ? 'danger' : 'primary'}
          disabled={!target}
          sublabel={target ? `${target.isBackup ? 'Backup' : (plan.yourStands ?? []).includes(target) ? 'Your stand' : `#${target.rank}`}: ${target.stand.name}${noGo ? ' · NO-GO today' : ''}` : 'No stand passed the plan'}
          onPress={startHunt}
        />
      </ScrollView>
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  const t = useTheme();
  return (
    <Text style={{ color: t.text, fontSize: font.md, marginTop: 4 }}>
      <Text style={{ color: t.textDim, fontWeight: '700' }}>{k}: </Text>
      {v}
    </Text>
  );
}

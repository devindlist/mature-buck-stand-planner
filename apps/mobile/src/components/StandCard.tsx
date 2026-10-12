import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { compass16, mToYds, type StandRecommendation } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font, RADIUS, SPACE } from '../theme/theme';
import { StatusChip, Label, BigButton } from './ui';
import { StatusIcon } from './Icons';
import { WindDialView } from './WindDialView';
import { fmtTime } from '../utils/format';

/** One swipeable card per stand. Score and each sub-score are tappable for the "why". */
export function StandCard({
  rec,
  title: titleOverride,
  width,
  onScorePress,
  onMove,
  onDismiss,
  onHunt,
}: {
  rec: StandRecommendation;
  /** Overrides the "#rank · name" title (e.g. for the hunter's own stands). */
  title?: string;
  width: number;
  onScorePress: (key?: string) => void;
  onMove: () => void;
  onDismiss: () => void;
  onHunt: () => void;
}) {
  const t = useTheme();
  const title = titleOverride ?? (rec.isBackup ? `Backup · ${rec.stand.name}` : `#${rec.rank} · ${rec.stand.name}`);
  const shot = rec.shotPlan;
  const noShot = shot.lanes.filter((l) => l.status === 'no_shot');
  return (
    <View style={{ width, paddingHorizontal: SPACE / 2 }}>
      <ScrollView style={{ backgroundColor: t.surface, borderRadius: RADIUS, borderWidth: 1, borderColor: rec.isBackup ? t.textDim : t.border }} contentContainerStyle={{ padding: SPACE + 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }} numberOfLines={1}>
              {title}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'center' }}>
              <StatusChip status={rec.decision.status} />
              <Text style={{ color: t.textDim, fontSize: font.xs }}>Confidence: {rec.confidence.level}</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Score ${rec.score.total} out of 100. Tap to see why.`}
            onPress={() => onScorePress()}
            style={{ width: 76, height: 76, borderRadius: 38, borderWidth: 3, borderColor: t.accent, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: t.text, fontSize: 28, fontWeight: '900' }}>{rec.score.total}</Text>
            <Text style={{ color: t.textDim, fontSize: 10, fontWeight: '700' }}>WHY?</Text>
          </Pressable>
        </View>

        {rec.backupNote ? <Text style={{ color: t.accent, fontSize: font.sm, marginTop: 8, fontWeight: '700' }}>{rec.backupNote}</Text> : null}
        <Text style={{ color: t.text, fontSize: font.md, marginTop: 10, lineHeight: 22 }}>{rec.reason}</Text>

        {rec.decision.status !== 'go' ? (
          <View style={{ marginTop: 8 }}>
            {rec.decision.reasons.map((r, i) => (
              <Text key={i} style={{ color: rec.decision.status === 'no_go' ? t.status.avoid : t.status.caution, fontSize: font.sm }}>
                • {r}
              </Text>
            ))}
          </View>
        ) : null}

        <Label>SUB-SCORES · TAP FOR WHY</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {rec.score.components.map((c) => (
            <Pressable
              key={c.key}
              accessibilityRole="button"
              accessibilityLabel={`${c.label} ${c.value} of ${c.max}`}
              onPress={() => onScorePress(c.key)}
              style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 10, backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border }}
            >
              <Text style={{ color: t.textDim, fontSize: 11 }}>
                {c.label}
                {c.tags.includes('low_confidence') ? ' ?' : ''}
              </Text>
              <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>
                {c.value}/{c.max}
              </Text>
            </Pressable>
          ))}
        </View>

        <Label>BEST SIT WINDOW</Label>
        <Text style={{ color: t.text, fontSize: font.md, fontWeight: '700' }}>
          {fmtTime(rec.sitWindow.start)} – {fmtTime(rec.sitWindow.end)}
        </Text>
        <Text style={{ color: t.textDim, fontSize: font.sm }}>{rec.sitWindow.label}</Text>

        <Label>WIND DIAL</Label>
        <WindDialView dial={rec.windDial} />

        <Label>ACCESS</Label>
        {[rec.entryRoute, rec.exitRoute].map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
            {r ? <StatusIcon status={r.worstStatus} color={t.status[r.worstStatus]} /> : <StatusIcon status="caution" color={t.status.caution} />}
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: font.md, fontWeight: '700' }}>
                {i === 0 ? 'Entry (solid line)' : 'Exit (dashed line)'}
                {r ? ` · ${Math.round(mToYds(r.lengthM))} yds from ${r.startLabel}` : ''}
              </Text>
              {r ? (
                r.segments
                  .filter((s) => s.status !== 'safe')
                  .slice(0, 2)
                  .map((s, j) => (
                    <Text key={j} style={{ color: t.status[s.status], fontSize: font.sm }}>
                      {s.status === 'avoid' ? '✕' : '!'} {s.reason}
                    </Text>
                  ))
              ) : (
                <Text style={{ color: t.textDim, fontSize: font.sm }}>Mark an access point to get a route.</Text>
              )}
              {r?.notes.map((n, j) => (
                <Text key={`n${j}`} style={{ color: t.textDim, fontSize: font.sm }}>
                  {n}
                </Text>
              ))}
            </View>
          </View>
        ))}

        <Label>SHOT PLAN</Label>
        <Text style={{ color: t.text, fontSize: font.md }}>
          {shot.expectedShotYds !== null ? `Expect ~${shot.expectedShotYds} yds to the ${compass16(shot.primaryBearingDeg ?? 0)}. ` : 'No travel within range. '}
          Max {shot.effectiveRangeYds} yds, no exceptions.
        </Text>
        {noShot.length ? (
          <Text style={{ color: t.status.avoid, fontSize: font.sm, fontWeight: '700', marginTop: 4 }}>
            ✕ NO SHOT toward {noShot.map((l) => compass16((l.fromDeg + 22.5) % 360)).join(', ')} (road/house)
          </Text>
        ) : null}
        {shot.notes.slice(1).map((n, i) => (
          <Text key={i} style={{ color: t.textDim, fontSize: font.sm }}>
            {n}
          </Text>
        ))}

        <Label>TOP RISKS</Label>
        {rec.risks.map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
            <StatusIcon status={r.severity >= 3 ? 'avoid' : r.severity === 2 ? 'caution' : 'safe'} color={r.severity >= 3 ? t.status.avoid : r.severity === 2 ? t.status.caution : t.textDim} size={18} />
            <Text style={{ color: t.text, fontSize: font.sm, flex: 1 }}>{r.text}</Text>
          </View>
        ))}

        <View style={{ marginTop: SPACE, padding: 10, borderRadius: 10, borderWidth: 1.5, borderColor: t.accent }}>
          <Text style={{ color: t.accent, fontWeight: '900', fontSize: font.sm }}>SAFETY</Text>
          {rec.safetyReminders.map((s, i) => (
            <Text key={i} style={{ color: t.text, fontSize: font.sm, marginTop: 2 }}>
              • {s}
            </Text>
          ))}
        </View>

        <Text style={{ color: t.textDim, fontSize: font.xs, marginTop: 8 }}>{rec.confidence.factors.join(' ')}</Text>

        <BigButton label="Hunt this stand" onPress={onHunt} disabled={rec.decision.status === 'no_go'} sublabel={rec.decision.status === 'no_go' ? 'No-go today' : undefined} style={{ marginTop: SPACE }} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <BigButton label="Move" kind="secondary" onPress={onMove} style={{ flex: 1 }} accessibilityHint="Then tap the map where the stand should be" />
          <BigButton label="Dismiss" kind="ghost" onPress={onDismiss} style={{ flex: 1 }} accessibilityHint="Removes this stand and re-plans" />
        </View>
      </ScrollView>
    </View>
  );
}

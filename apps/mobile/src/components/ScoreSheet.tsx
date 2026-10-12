import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ScoreBreakdown } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font, RADIUS, SPACE } from '../theme/theme';
import { BigButton } from './ui';
import { LowConfidenceTag } from './Icons';

/** "Tap any score to see why": every component with its points and plain-language reasons. */
export function ScoreSheet({ visible, onClose, title, score, focusKey }: { visible: boolean; onClose: () => void; title: string; score: ScoreBreakdown | null; focusKey?: string }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!score) return null;
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#0009' }} onPress={onClose} accessibilityLabel="Close score details" />
      <View style={{ maxHeight: '80%', backgroundColor: t.surface, borderTopLeftRadius: RADIUS * 1.5, borderTopRightRadius: RADIUS * 1.5, padding: SPACE + 4, paddingBottom: insets.bottom + SPACE }}>
        <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>
          {title}: {score.total}/100
        </Text>
        <ScrollView style={{ marginTop: SPACE }}>
          {score.components.map((c) => {
            const pct = c.max ? c.value / c.max : 0;
            const focused = c.key === focusKey;
            return (
              <View key={c.key} style={{ marginBottom: SPACE + 4, borderLeftWidth: focused ? 3 : 0, borderLeftColor: t.accent, paddingLeft: focused ? 8 : 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: t.text, fontSize: font.md, fontWeight: '700' }}>{c.label}</Text>
                  <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>
                    {c.value} / {c.max}
                  </Text>
                </View>
                <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surfaceAlt, marginVertical: 6 }}>
                  <View style={{ width: `${Math.round(pct * 100)}%`, height: 8, borderRadius: 4, backgroundColor: pct >= 0.7 ? t.status.safe : pct >= 0.4 ? t.status.caution : t.status.avoid }} />
                </View>
                {c.tags.includes('low_confidence') ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <LowConfidenceTag color={t.textDim} />
                    <Text style={{ color: t.textDim, fontSize: font.xs, fontWeight: '700' }}>INCLUDES LOW-CONFIDENCE MODIFIERS</Text>
                  </View>
                ) : null}
                {c.tags.includes('observed_data') ? <Text style={{ color: t.accent, fontSize: font.xs, fontWeight: '700', marginBottom: 4 }}>BACKED BY YOUR OBSERVATIONS</Text> : null}
                {c.reasons.map((r, i) => (
                  <Text key={i} style={{ color: r.startsWith('[Low confidence]') ? t.textDim : t.text, fontSize: font.sm, lineHeight: 20 }}>
                    • {r.replace('[Low confidence] ', '')}
                  </Text>
                ))}
              </View>
            );
          })}
        </ScrollView>
        <BigButton label="Close" kind="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

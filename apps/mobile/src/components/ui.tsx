import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Status } from '@msp/engine';
import { useTheme } from '../theme/ThemeContext';
import { font, RADIUS, SPACE, TOUCH } from '../theme/theme';
import { StatusIcon } from './Icons';
import { WIND_BADGE_RESERVED } from './WindBadge';
import { useAppStore } from '../state/store';
import { tap } from '../services/device';

/** Screen chrome: title on the left, top-right always reserved for the global wind badge. */
export function Screen({ title, children, onBack, right, scroll = true }: { title: string; children: React.ReactNode; onBack?: () => void; right?: React.ReactNode; scroll?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={[styles.header, { paddingRight: WIND_BADGE_RESERVED }]}>
        {onBack ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={12} style={styles.back}>
            <Text style={{ color: t.text, fontSize: 30, lineHeight: 32 }}>‹</Text>
          </Pressable>
        ) : null}
        <Text numberOfLines={1} style={[styles.title, { color: t.text }]}>
          {title}
        </Text>
        {right}
      </View>
      <View style={{ flex: 1, paddingBottom: scroll ? 0 : insets.bottom }}>{children}</View>
    </View>
  );
}

export function BigButton({
  label,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  sublabel,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  sublabel?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const t = useTheme();
  const haptics = useAppStore((s) => s.settings.haptics);
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : kind === 'secondary' ? t.surfaceAlt : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? t.accentText : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || loading}
      onPress={() => {
        tap(haptics);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'ghost' ? t.border : bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>}
      {sublabel && !loading ? <Text style={{ color: fg, opacity: 0.8, fontSize: font.xs, marginTop: 2 }}>{sublabel}</Text> : null}
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange, labels }: { options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  const t = useTheme();
  return (
    <View style={[styles.segmented, { borderColor: t.border, backgroundColor: t.surface }]} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o)}
            style={[styles.segment, { backgroundColor: on ? t.accent : 'transparent' }]}
          >
            <Text style={{ color: on ? t.accentText : t.text, fontSize: font.md, fontWeight: '700' }}>{labels?.[o] ?? o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Stepper({ label, value, onChange, step = 1, min = 0, max = 999, unit, badge }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; badge?: string }) {
  const t = useTheme();
  const btn = (delta: number, txt: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${txt === '−' ? 'Decrease' : 'Increase'} ${label}`}
      onPress={() => onChange(Math.max(min, Math.min(max, Math.round((value + delta) * 10) / 10)))}
      style={[styles.stepBtn, { backgroundColor: t.surfaceAlt, borderColor: t.border }]}
    >
      <Text style={{ color: t.text, fontSize: 26, fontWeight: '700' }}>{txt}</Text>
    </Pressable>
  );
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.textDim, fontSize: font.sm }}>{label}</Text>
        <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '700' }}>
          {value}
          {unit ? ` ${unit}` : ''} {badge ? <Text style={{ color: t.accent, fontSize: font.xs }}>{badge}</Text> : null}
        </Text>
      </View>
      {btn(-step, '−')}
      {btn(step, '+')}
    </View>
  );
}

export function StatusChip({ status, label }: { status: Status | 'go' | 'no_go'; label?: string }) {
  const t = useTheme();
  const s: Status = status === 'go' ? 'safe' : status === 'no_go' ? 'avoid' : status;
  const text = label ?? (status === 'go' ? 'GO' : status === 'no_go' ? 'NO-GO' : status === 'caution' ? 'CAUTION' : status === 'safe' ? 'SAFE' : 'AVOID');
  return (
    <View style={[styles.chip, { borderColor: t.status[s] }]} accessibilityLabel={text}>
      <StatusIcon status={s} color={t.status[s]} size={18} />
      <Text style={{ color: t.status[s], fontWeight: '800', fontSize: font.sm, marginLeft: 6 }}>{text}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.textDim, fontSize: font.sm, marginBottom: 6, marginTop: SPACE, fontWeight: '600', letterSpacing: 0.4 }}>{children}</Text>;
}

export function Body({ children, dim, style }: { children: React.ReactNode; dim?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: dim ? t.textDim : t.text, fontSize: font.md, lineHeight: 22 }, style]}>{children}</Text>;
}

export function Field(props: TextInputProps & { label: string }) {
  const t = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginTop: SPACE }}>
      <Text style={{ color: t.textDim, fontSize: font.sm, marginBottom: 6 }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.textDim}
        style={[{ minHeight: TOUCH, borderRadius: RADIUS, borderWidth: 1, borderColor: t.border, backgroundColor: t.surfaceAlt, color: t.text, paddingHorizontal: 14, fontSize: font.md }, style]}
        {...rest}
      />
    </View>
  );
}

export function Disclaimer({ text }: { text: string }) {
  const t = useTheme();
  return <Text style={{ color: t.textDim, fontSize: font.xs, lineHeight: 16, marginVertical: SPACE }}>{text}</Text>;
}

const styles = StyleSheet.create({
  header: { minHeight: TOUCH + 8, flexDirection: 'row', alignItems: 'center', paddingLeft: SPACE },
  back: { width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center', marginLeft: -SPACE / 2 },
  title: { fontSize: font.lg, fontWeight: '800', flex: 1 },
  button: { minHeight: TOUCH, borderRadius: RADIUS, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, borderWidth: 1.5, marginVertical: 6 },
  buttonText: { fontSize: font.md + 1, fontWeight: '800', letterSpacing: 0.3 },
  segmented: { flexDirection: 'row', borderRadius: RADIUS, borderWidth: 1, overflow: 'hidden' },
  segment: { flex: 1, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 6 },
  stepBtn: { width: TOUCH, height: TOUCH, borderRadius: RADIUS, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  card: { borderWidth: 1, borderRadius: RADIUS, padding: SPACE + 2, marginVertical: 6 },
});

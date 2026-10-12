import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAppStore } from '../src/state/store';
import { useForecast } from '../src/state/useForecast';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Disclaimer, Label, Screen } from '../src/components/ui';
import { ConditionsStrip } from '../src/components/ConditionsStrip';
import { propertyLocation } from '../src/services/planning';
import { setSetting } from '../src/db/repos';
import { fmtDate } from '../src/utils/format';
import { font, SPACE, TOUCH } from '../src/theme/theme';
import { DISCLAIMER } from '@msp/engine';

/** Home: conditions strip + one big Plan Hunt button. Everything else is secondary. */
export default function Home() {
  const t = useTheme();
  const properties = useAppStore((s) => s.properties);
  const property = useAppStore((s) => s.activeProperty());
  const weather = useAppStore((s) => s.weather);
  const weatherStatus = useAppStore((s) => s.weatherStatus);
  const weatherError = useAppStore((s) => s.weatherError);
  const draft = useAppStore((s) => s.draft);
  const plan = useAppStore((s) => s.plan);
  const hunt = useAppStore((s) => s.hunt);
  const set = useAppStore((s) => s.set);
  useForecast();

  const loc = property ? propertyLocation(property) : undefined;

  return (
    <Screen title="Stand Planner" scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 40 }}>
        <ConditionsStrip weather={weather} location={loc} date={draft.date} stateCode={property?.stateCode ?? 'IA'} status={weatherStatus} note={weatherError} />

        {hunt ? <BigButton label="Return to active hunt" kind="danger" onPress={() => router.push('/hunt')} style={{ marginTop: SPACE }} /> : null}

        <BigButton
          label="PLAN HUNT"
          sublabel={property ? `${property.name} · ${fmtDate(draft.date)} ${draft.window}` : 'Add your property map first'}
          onPress={() => router.push(property ? '/plan' : '/calibrate')}
          style={{ minHeight: 92, marginTop: SPACE }}
        />

        {plan ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <BigButton label="Last plan" kind="secondary" onPress={() => router.push('/results')} style={{ flex: 1 }} />
            <BigButton label="Plan card" kind="secondary" sublabel="works offline" onPress={() => router.push('/plan-card')} style={{ flex: 1 }} />
          </View>
        ) : null}

        <Label>PROPERTIES</Label>
        {properties.length === 0 ? (
          <Card>
            <Body>Add a photo of your property map: an aerial, a topo, or an onX/HuntStand screenshot. You'll calibrate north and scale, then review what the app finds.</Body>
          </Card>
        ) : (
          properties.map((p) => {
            const active = p.id === property?.id;
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  set({ activePropertyId: p.id });
                  void setSetting('activePropertyId', p.id);
                }}
                style={{ minHeight: TOUCH, borderRadius: 12, borderWidth: active ? 2 : 1, borderColor: active ? t.accent : t.border, backgroundColor: t.surface, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center' }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: font.md, fontWeight: '800' }}>{p.name}</Text>
                  <Text style={{ color: t.textDim, fontSize: font.xs }}>
                    {p.stateCode} · {p.features.filter((f) => f.status === 'active').length} features · {p.stands.filter((s) => !s.dismissed).length} stands ·{' '}
                    {p.calibration?.originGeo ? 'geo-referenced' : 'photo only'}
                  </Text>
                </View>
                {active ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${p.name} map`} onPress={() => router.push('/features')} style={{ minHeight: 48, paddingHorizontal: 14, justifyContent: 'center' }}>
                    <Text style={{ color: t.accent, fontWeight: '800' }}>Edit map</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })
        )}
        <BigButton label="+ Add property map" kind="ghost" onPress={() => router.push('/calibrate')} />

        <View style={{ flexDirection: 'row', gap: 8, marginTop: SPACE }}>
          <BigButton label="Log a hunt" kind="secondary" onPress={() => router.push('/log')} style={{ flex: 1 }} disabled={!property} />
          <BigButton label="Settings" kind="secondary" onPress={() => router.push('/settings')} style={{ flex: 1 }} />
        </View>

        <Disclaimer text={DISCLAIMER} />
      </ScrollView>
    </Screen>
  );
}

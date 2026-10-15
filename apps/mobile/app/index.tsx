import React, { useCallback } from 'react';
import { AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useAppStore } from '../src/state/store';
import { useForecast, useForecastFreshness } from '../src/state/useForecast';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Disclaimer, Label, Screen } from '../src/components/ui';
import { ConditionsStrip } from '../src/components/ConditionsStrip';
import { StatusIcon } from '../src/components/Icons';
import { conditionsConfirmed, defaultSit, planLocation, useApproxLocations } from '../src/services/planning';
import { setSetting } from '../src/db/repos';
import { fmtDate, sitOrder } from '../src/utils/format';
import { font, SPACE, TOUCH } from '../src/theme/theme';
import { DISCLAIMER } from '@msp/engine';

/**
 * A draft whose sit has already ended (yesterday's date, or this morning after the
 * morning sit) moves to the next sit. A sit the hunter picked in the future is kept.
 * Weather overrides belonged to the ended sit, so they are cleared with it.
 * Left alone during an active hunt: Hunt mode still needs that sit's wind.
 */
function rollDraftForward(): void {
  const s = useAppStore.getState();
  if (s.hunt) return;
  const next = defaultSit(s.activeProperty(), s.draft.phaseOverride);
  if (sitOrder(s.draft) < sitOrder(next)) s.setDraft({ date: next.date, window: next.window, overrides: {} });
}

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
  const { current, loading } = useForecastFreshness();
  const approx = useApproxLocations((s) => (property ? s.byProperty[property.id] : undefined));

  // Home focus and app resume: never sit on a date that has already passed.
  useFocusEffect(
    useCallback(() => {
      rollDraftForward();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') rollDraftForward();
      });
      return () => sub.remove();
    }, []),
  );

  const { loc, approximate } = property ? planLocation(property, approx) : { loc: undefined, approximate: false };

  return (
    <Screen title="Stand Planner" scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 40 }}>
        <ConditionsStrip
          // Not another sit's weather, and not placeholder defaults while the forecast is still on its way.
          weather={current && !(loading && weather?.placeholder && !conditionsConfirmed(draft.overrides)) ? weather : null}
          location={loc}
          date={draft.date}
          stateCode={property?.stateCode ?? 'IA'}
          status={weatherStatus}
          note={weatherError}
          overrides={draft.overrides}
          phaseOverride={draft.phaseOverride}
          approximateLocation={approximate}
        />

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
                  {p.analysisMode === 'mock' ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <StatusIcon status="caution" color={t.status.caution} size={16} />
                      <Text style={{ color: t.status.caution, fontSize: font.xs, fontWeight: '800' }}>SAMPLE FEATURES: not from your photo</Text>
                    </View>
                  ) : null}
                </View>
                {active ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${p.name} map`} onPress={() => router.push('/features')} style={{ minHeight: TOUCH, paddingHorizontal: 14, justifyContent: 'center' }}>
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

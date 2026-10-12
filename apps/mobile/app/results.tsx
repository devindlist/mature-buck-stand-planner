import React, { useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Text, useWindowDimensions, View, type ViewToken } from 'react-native';
import { Redirect, router } from 'expo-router';
import { pixelToLocal, compass16, type PixelPoint, type Stand, type StandRecommendation } from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Screen, Segmented } from '../src/components/ui';
import { PhotoMap, type MapStand } from '../src/components/PhotoMap';
import { GeoMap } from '../src/components/GeoMap';
import { StandCard } from '../src/components/StandCard';
import { ScoreSheet } from '../src/components/ScoreSheet';
import { StatusIcon } from '../src/components/Icons';
import { runPlan } from '../src/services/planning';
import { saveProperty } from '../src/db/repos';
import { uid } from '../src/utils/format';
import { font, SPACE } from '../src/theme/theme';

/**
 * Results: map first. Swipe the cards; the map follows. Tap a stand on the map to jump
 * to its card. Tap any score for the "why". Move or dismiss any stand and the plan re-runs.
 */
export default function Results() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const planState = useAppStore((s) => s.plan);
  const property = useAppStore((s) => s.properties.find((p) => p.id === s.plan?.plan.propertyId) ?? null);
  const draft = useAppStore((s) => s.draft);
  const weather = useAppStore((s) => s.weather);
  const selectedStandId = useAppStore((s) => s.selectedStandId);
  const set = useAppStore((s) => s.set);
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const [layer, setLayer] = useState<'photo' | 'basemap'>('photo');
  const [sheet, setSheet] = useState<{ rec: StandRecommendation; key?: string } | null>(null);
  const [moving, setMoving] = useState<StandRecommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEliminated, setShowEliminated] = useState(false);
  const listRef = useRef<FlatList<StandRecommendation>>(null);

  const recs = useMemo(
    () => (planState ? [...planState.plan.recommendations, ...(planState.plan.backup ? [planState.plan.backup] : []), ...(planState.plan.yourStands ?? [])] : []),
    [planState],
  );
  const isYours = (r: StandRecommendation) => !!planState?.plan.yourStands?.includes(r);
  const selected = recs.find((r) => r.stand.id === selectedStandId) ?? recs[0];

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0]?.item as StandRecommendation | undefined;
    if (first) useAppStore.getState().set({ selectedStandId: first.stand.id });
  }).current;

  if (!planState || !property?.calibration || !property.mapImageUri) return <Redirect href="/" />;
  const { plan } = planState;
  const cal = property.calibration;
  const geo = !!cal.originGeo;

  const replan = async (next: typeof property) => {
    if (!weather) return;
    setBusy(true);
    try {
      const saved = await saveProperty(next);
      upsertProperty(saved);
      const result = await runPlan(saved, draft, plan.inputs.weather ?? weather, plan.inputs.location);
      set({ plan: result, selectedStandId: result.plan.recommendations[0]?.stand.id ?? null });
    } finally {
      setBusy(false);
    }
  };

  const onMapTap = (px: PixelPoint) => {
    if (!moving) return;
    const p = pixelToLocal(cal, px);
    const s = moving.stand;
    // Moving any stand makes it the hunter's own: it is always evaluated from now on.
    const mine: Stand = s.origin === 'existing' ? { ...s, position: p } : { id: uid('stand'), propertyId: property.id, name: s.name, position: p, origin: 'existing', type: s.type };
    const stands = s.origin === 'existing' ? property.stands.map((x) => (x.id === s.id ? mine : x)) : [...property.stands, mine];
    const dismissed = s.origin === 'generated' ? [...(property.dismissedCandidatePositions ?? []), s.position] : property.dismissedCandidatePositions;
    setMoving(null);
    void replan({ ...property, stands, dismissedCandidatePositions: dismissed });
  };

  const dismiss = (rec: StandRecommendation) => {
    Alert.alert(`Dismiss ${rec.stand.name}?`, 'The plan will re-run without it. You can restore it from the map editor.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Dismiss',
        style: 'destructive',
        onPress: () => {
          const s = rec.stand;
          void replan(
            s.origin === 'existing'
              ? { ...property, stands: property.stands.map((x) => (x.id === s.id ? { ...x, dismissed: true } : x)) }
              : { ...property, dismissedCandidatePositions: [...(property.dismissedCandidatePositions ?? []), s.position] },
          );
        },
      },
    ]);
  };

  const mapStands: MapStand[] = recs.map((r) => ({
    id: r.stand.id,
    position: r.stand.position,
    label: r.stand.name,
    rank: r.isBackup ? 4 : isYours(r) ? undefined : r.rank,
    existing: r.stand.origin === 'existing',
    selected: r.stand.id === selected?.stand.id,
    status: r.decision.status,
  }));
  const routes = selected ? [selected.entryRoute, selected.exitRoute].filter((r): r is NonNullable<typeof r> => !!r) : [];
  const mapH = height * 0.42;
  const cardW = width;

  const banner = plan.warnings.find((w) => w.level === 'no_go') ?? plan.warnings.find((w) => w.level === 'caution');

  return (
    <Screen title={`${plan.inputs.window} · ${plan.phase.label}`} onBack={() => router.back()} scroll={false}>
      <View style={{ height: mapH, overflow: 'hidden' }}>
        {layer === 'basemap' && geo ? (
          <GeoMap property={property} basemap="imageryTopo" habitat={plan.habitat} stands={mapStands} routes={routes} onPressStand={(id) => jumpTo(id)} />
        ) : (
          <PhotoMap
            imageUri={property.mapImageUri}
            calibration={cal}
            width={width}
            maxHeight={mapH}
            habitat={plan.habitat}
            features={property.features.filter((f) => ['road', 'house', 'access_point', 'saddle', 'funnel', 'creek_crossing', 'inside_corner'].includes(f.type))}
            stands={mapStands}
            routes={routes}
            plumes={selected ? { origin: selected.stand.position, plumes: selected.plumes } : undefined}
            onPressStand={moving ? undefined : (id) => jumpTo(id)}
            onPressPixel={moving ? onMapTap : undefined}
          />
        )}
        <View style={{ position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', gap: 6 }}>
          <Legend color={t.status.safe} label="safe" status="safe" />
          <Legend color={t.status.caution} label="caution" status="caution" />
          <Legend color={t.status.avoid} label="avoid" status="avoid" />
        </View>
      </View>
      {moving ? (
        <View style={{ backgroundColor: t.accent, padding: 10, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.accentText, fontWeight: '800', flex: 1 }}>Tap the map where {moving.stand.name} should go</Text>
          <Pressable onPress={() => setMoving(null)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 }}>
            <Text style={{ color: t.accentText, fontWeight: '900' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : banner ? (
        <View style={{ backgroundColor: t.surfaceAlt, paddingHorizontal: SPACE, paddingVertical: 6, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <StatusIcon status={banner.level === 'no_go' ? 'avoid' : 'caution'} color={banner.level === 'no_go' ? t.status.avoid : t.status.caution} size={18} />
          <Text style={{ color: t.text, fontSize: font.sm, flex: 1 }} numberOfLines={2}>
            {banner.text}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', paddingHorizontal: SPACE, paddingTop: 6, gap: 8, alignItems: 'center' }}>
        {geo ? (
          <View style={{ flex: 1 }}>
            <Segmented options={['photo', 'basemap'] as const} value={layer} onChange={setLayer} labels={{ photo: 'Photo', basemap: 'USGS map' }} />
          </View>
        ) : (
          <Text style={{ color: t.textDim, fontSize: font.xs, flex: 1 }}>Wind {compass16(plan.inputs.weather.windFromDeg)} · solid = entry, dashed = exit</Text>
        )}
        <Text style={{ color: t.textDim, fontSize: font.xs }}>
          {recs.findIndex((r) => r.stand.id === selected?.stand.id) + 1}/{recs.length}
        </Text>
      </View>

      {recs.length === 0 ? (
        <View style={{ padding: SPACE }}>
          <Text style={{ color: t.text, fontSize: font.md }}>No stand passes today’s wind and safety checks. Staying out keeps the property fresh for a better wind.</Text>
          <BigButton label="Why? See eliminated stands" kind="secondary" onPress={() => setShowEliminated(true)} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={recs}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(r) => r.stand.id}
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          getItemLayout={(_, i) => ({ length: cardW, offset: cardW * i, index: i })}
          style={{ flex: 1, marginTop: 6 }}
          renderItem={({ item }) => (
            <StandCard
              rec={item}
              title={isYours(item) ? `Your stand · ${item.stand.name}` : undefined}
              width={cardW}
              onScorePress={(key) => setSheet({ rec: item, key })}
              onMove={() => setMoving(item)}
              onDismiss={() => dismiss(item)}
              onHunt={() => router.push({ pathname: '/hunt', params: { standId: item.stand.id } })}
            />
          )}
        />
      )}

      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: SPACE }}>
        <BigButton label="Plan card" kind="secondary" onPress={() => router.push('/plan-card')} style={{ flex: 1 }} />
        <BigButton label={`Eliminated (${plan.eliminated.length})`} kind="ghost" onPress={() => setShowEliminated((v) => !v)} style={{ flex: 1 }} loading={busy} />
      </View>
      {showEliminated ? (
        <View style={{ maxHeight: 180, paddingHorizontal: SPACE, paddingBottom: SPACE }}>
          <FlatList
            data={plan.eliminated}
            keyExtractor={(e) => e.stand.id}
            renderItem={({ item }) => (
              <Text style={{ color: t.textDim, fontSize: font.sm, marginBottom: 4 }}>
                ✕ <Text style={{ color: t.text, fontWeight: '700' }}>{item.stand.name}</Text>: {item.reasons.join(' ')}
              </Text>
            )}
          />
        </View>
      ) : null}

      <ScoreSheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet?.rec.stand.name ?? ''} score={sheet?.rec.score ?? null} focusKey={sheet?.key} />
    </Screen>
  );

  function jumpTo(id: string) {
    const i = recs.findIndex((r) => r.stand.id === id);
    if (i >= 0) {
      set({ selectedStandId: id });
      listRef.current?.scrollToIndex({ index: i, animated: true });
    }
  }
}

function Legend({ color, label, status }: { color: string; label: string; status: 'safe' | 'caution' | 'avoid' }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.bg + 'CC', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3, gap: 4 }}>
      <StatusIcon status={status} color={color} size={14} />
      <Text style={{ color: t.text, fontSize: 11 }}>{label}</Text>
    </View>
  );
}

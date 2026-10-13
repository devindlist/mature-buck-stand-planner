import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, Text, useWindowDimensions, View, type ViewToken } from 'react-native';
import { Redirect, router } from 'expo-router';
import { compass16, geoToLocal, pixelToLocal, type LatLon, type PixelPoint, type Plan, type PlanInputs, type Property, type Stand, type StandRecommendation, type Vec } from '@msp/engine';
import { useAppStore, type PlanDraft } from '../src/state/store';
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
import { font, SPACE, TOUCH } from '../src/theme/theme';

/** The stands the cards and the map show, in card order: top 3, backup, then the hunter's own. */
const recsOf = (p: Plan): StandRecommendation[] => [...p.recommendations, ...(p.backup ? [p.backup] : []), ...(p.yourStands ?? [])];

/**
 * A re-plan answers the same question as the plan on screen: its own date, window, weapon,
 * range, phase and setback overrides. The live draft on Plan may have moved on (or been reset
 * after a relaunch), and must not change what this plan is about. The weather already has the
 * hunter's overrides applied, so none are re-applied.
 */
function draftFromInputs(i: PlanInputs): PlanDraft {
  return {
    date: i.date,
    window: i.window,
    weaponType: i.weapon.type,
    rangeYds: i.weapon.effectiveRangeYds,
    phaseOverride: i.phaseOverride,
    setbackOverrideM: i.beddingSetbackOverrideM,
    overrides: {},
  };
}

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
  const liveWeather = useAppStore((s) => s.weather);
  const selectedStandId = useAppStore((s) => s.selectedStandId);
  const set = useAppStore((s) => s.set);
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const [layer, setLayer] = useState<'photo' | 'basemap'>('photo');
  const [sheet, setSheet] = useState<{ rec: StandRecommendation; key?: string } | null>(null);
  const [moving, setMoving] = useState<StandRecommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEliminated, setShowEliminated] = useState(false);
  const listRef = useRef<FlatList<StandRecommendation>>(null);
  /** Synchronous lock: a state flag lags a render behind, so a fast second tap could slip past it. */
  const replanning = useRef(false);
  /** The stand whose card must be showing once the re-planned list is on screen. */
  const focusAfterReplan = useRef<string | null>(null);

  const recs = useMemo(() => (planState ? recsOf(planState.plan) : []), [planState]);
  const isYours = (r: StandRecommendation) => !!planState?.plan.yourStands?.includes(r);
  const selected = recs.find((r) => r.stand.id === selectedStandId) ?? recs[0];

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0]?.item as StandRecommendation | undefined;
    if (first) useAppStore.getState().set({ selectedStandId: first.stand.id });
  }).current;

  // After a re-plan the list has new data but keeps its old scroll offset, and the visible card
  // may keep its key (a moved stand keeps its id), so no viewability event would follow. Scroll to
  // the acted-on stand so the card, the map highlight, routes and plume all belong together.
  useEffect(() => {
    const id = focusAfterReplan.current;
    if (!id) return;
    focusAfterReplan.current = null;
    const i = recs.findIndex((r) => r.stand.id === id);
    if (i < 0) return;
    try {
      listRef.current?.scrollToIndex({ index: i, animated: false });
    } catch {
      /* the list is not laid out yet; the selection above still drives the map */
    }
  }, [recs]);

  if (!planState || !property?.calibration || !property.mapImageUri) return <Redirect href="/" />;
  const { plan } = planState;
  const cal = property.calibration;
  const geo = !!cal.originGeo;

  /**
   * Saves the changed property and re-plans it from this plan's own inputs. One at a time:
   * taps that arrive while a re-plan runs are ignored. On failure nothing is half-applied
   * (the property is put back) and the hunter is told.
   */
  const replan = async (next: Property, focusId: string | null) => {
    if (replanning.current) return;
    replanning.current = true;
    setBusy(true);
    const before = property;
    let saved: Property | null = null;
    try {
      saved = await saveProperty(next);
      upsertProperty(saved);
      const i = plan.inputs;
      const result = await runPlan(saved, draftFromInputs(i), i.weather, i.location);
      const nextRecs = recsOf(result.plan);
      const keep = focusId && nextRecs.some((r) => r.stand.id === focusId) ? focusId : (nextRecs[0]?.stand.id ?? null);
      focusAfterReplan.current = keep;
      set({ plan: result, selectedStandId: keep });
      const out = focusId ? result.plan.eliminated.find((e) => e.stand.id === focusId) : undefined;
      if (out) Alert.alert(`${out.stand.name} is not huntable`, out.reasons.join(' ') || 'It failed the wind or safety checks.');
    } catch (e) {
      if (saved) {
        // Put the stands back as they were so the saved map matches the plan on screen.
        try {
          upsertProperty(await saveProperty(before));
        } catch {
          /* the original error below is the one to report */
        }
      }
      Alert.alert('Re-plan failed', `${e instanceof Error ? e.message : 'Something went wrong.'} Your stands were left as they were.`);
    } finally {
      replanning.current = false;
      setBusy(false);
    }
  };

  /** Where a moved stand should go, in local meters. */
  const placeMoved = (p: Vec) => {
    if (!moving || replanning.current) return;
    const s = moving.stand;
    // Moving any stand makes it the hunter's own: it is always evaluated from now on.
    const mine: Stand = s.origin === 'existing' ? { ...s, position: p } : { id: uid('stand'), propertyId: property.id, name: s.name, position: p, origin: 'existing', type: s.type };
    const stands = s.origin === 'existing' ? property.stands.map((x) => (x.id === s.id ? mine : x)) : [...property.stands, mine];
    const dismissed = s.origin === 'generated' ? [...(property.dismissedCandidatePositions ?? []), s.position] : property.dismissedCandidatePositions;
    setMoving(null);
    void replan({ ...property, stands, dismissedCandidatePositions: dismissed }, mine.id);
  };
  const onMapTap = (px: PixelPoint) => placeMoved(pixelToLocal(cal, px));
  const onBasemapTap = (at: LatLon) => {
    if (cal.originGeo) placeMoved(geoToLocal(at, cal.originGeo));
  };

  const dismiss = (rec: StandRecommendation) => {
    if (replanning.current) return;
    Alert.alert(`Dismiss ${rec.stand.name}?`, 'The plan will re-run without it. You can restore it from the map editor (Removed stands).', [
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
            null,
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
  const mapFeatures = property.features.filter((f) => ['road', 'house', 'access_point', 'saddle', 'funnel', 'creek_crossing', 'inside_corner'].includes(f.type));
  const plumes = selected ? { origin: selected.stand.position, plumes: selected.plumes } : undefined;
  const mock = property.analysisMode === 'mock';
  const mapH = height * (mock ? 0.38 : 0.42);
  const cardW = width;

  const banner = plan.warnings.find((w) => w.level === 'no_go') ?? plan.warnings.find((w) => w.level === 'caution');

  // The wind arrow at top right follows the Plan screen; this plan was made with its own wind.
  const planWind = plan.inputs.weather;
  const badgeFrom = draft.overrides.windFromDeg ?? liveWeather?.windFromDeg;
  const windMoved = badgeFrom !== undefined && compass16(badgeFrom) !== compass16(planWind.windFromDeg);
  const assumed = selected?.assumedWindFromDeg;

  return (
    <Screen title={`${plan.inputs.window} · ${plan.phase.label}`} onBack={() => router.back()} scroll={false}>
      {mock ? (
        <View accessible accessibilityRole="alert" accessibilityLabel="Mock analysis. Sample features, not from your photo." style={{ backgroundColor: t.surfaceAlt, borderBottomWidth: 2, borderBottomColor: t.status.caution, paddingHorizontal: SPACE, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusIcon status="caution" color={t.status.caution} size={22} />
          <Text style={{ color: t.status.caution, fontSize: font.sm, fontWeight: '900' }}>MOCK ANALYSIS</Text>
          <Text style={{ color: t.text, fontSize: font.xs, flex: 1 }} numberOfLines={2}>
            Sample features, not from your photo. Review the map before you trust this plan.
          </Text>
        </View>
      ) : null}
      <View style={{ height: mapH, overflow: 'hidden' }}>
        {layer === 'basemap' && geo ? (
          <GeoMap
            property={property}
            basemap="imageryTopo"
            habitat={plan.habitat}
            features={mapFeatures}
            constraints={property.accessConstraints}
            stands={mapStands}
            routes={routes}
            plumes={plumes}
            onPressStand={moving ? undefined : (id) => jumpTo(id)}
            onPressMap={moving ? onBasemapTap : undefined}
          />
        ) : (
          <PhotoMap
            imageUri={property.mapImageUri}
            calibration={cal}
            width={width}
            maxHeight={mapH}
            habitat={plan.habitat}
            features={mapFeatures}
            constraints={property.accessConstraints}
            stands={mapStands}
            routes={routes}
            plumes={plumes}
            onPressStand={moving ? undefined : (id) => jumpTo(id)}
            onPressPixel={moving ? onMapTap : undefined}
          />
        )}
        {assumed !== undefined ? (
          <View accessible accessibilityLabel={`Scent plume drawn for a ${compass16(assumed)} wind, not today’s forecast`} style={{ position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.bg + 'E6', borderRadius: 10, borderWidth: 1.5, borderColor: t.status.caution, paddingHorizontal: 8, paddingVertical: 4, maxWidth: '80%' }}>
            <StatusIcon status="caution" color={t.status.caution} size={16} />
            <Text style={{ color: t.text, fontSize: font.xs, fontWeight: '800', flexShrink: 1 }}>Plume and dial: if wind is {compass16(assumed)} (not today’s forecast)</Text>
          </View>
        ) : null}
        <View style={{ position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', gap: 6 }}>
          <Legend color={t.status.safe} label="safe" status="safe" />
          <Legend color={t.status.caution} label="caution" status="caution" />
          <Legend color={t.status.avoid} label="avoid" status="avoid" />
        </View>
      </View>
      {moving ? (
        <View style={{ backgroundColor: t.accent, padding: 10, flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.accentText, fontWeight: '800', flex: 1 }}>Tap the map where {moving.stand.name} should go</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel move" onPress={() => setMoving(null)} style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: 14 }}>
            <Text style={{ color: t.accentText, fontWeight: '900' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : busy ? (
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: t.accent, padding: 10 }}>
          <Text style={{ color: t.accentText, fontWeight: '800' }}>Re-planning with your change…</Text>
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
          <View style={{ flex: 1 }} />
        )}
        <Text style={{ color: t.textDim, fontSize: font.xs }}>
          {recs.findIndex((r) => r.stand.id === selected?.stand.id) + 1}/{recs.length}
        </Text>
      </View>
      <Text style={{ color: t.textDim, fontSize: font.xs, paddingHorizontal: SPACE, paddingTop: 4 }}>
        Plan wind {compass16(planWind.windFromDeg)} {Math.round(planWind.windSpeedMph)} mph · solid = entry (IN), dashed = exit (OUT)
      </Text>
      {windMoved ? (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: SPACE, paddingTop: 2 }}>
          <StatusIcon status="caution" color={t.status.caution} size={16} />
          <Text style={{ color: t.status.caution, fontSize: font.xs, fontWeight: '700', flex: 1 }}>
            The wind badge now shows {compass16(badgeFrom!)}; this plan used {compass16(planWind.windFromDeg)}. Plan again to use the newer wind.
          </Text>
        </View>
      ) : null}

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
              busy={busy}
              onScorePress={(key) => setSheet({ rec: item, key })}
              onMove={() => {
                if (!replanning.current) setMoving(item);
              }}
              onDismiss={() => dismiss(item)}
              onHunt={() => router.push({ pathname: '/hunt', params: { standId: item.stand.id } })}
            />
          )}
        />
      )}

      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: SPACE }}>
        <BigButton label="Plan card" kind="secondary" onPress={() => router.push('/plan-card')} style={{ flex: 1 }} />
        <BigButton label={`Eliminated (${plan.eliminated.length})`} kind="ghost" onPress={() => setShowEliminated((v) => !v)} style={{ flex: 1 }} />
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
      try {
        listRef.current?.scrollToIndex({ index: i, animated: true });
      } catch {
        /* list not laid out yet; the map selection still moved */
      }
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

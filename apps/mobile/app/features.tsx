import React, { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import {
  FEATURE_TYPES,
  geometryCentroid,
  localToPixel,
  pixelToLocal,
  pointGeometryDistance,
  sub,
  add,
  type CropType,
  type FeatureType,
  type MapFeature,
  type PixelPoint,
  type Property,
  type Stand,
  type Vec,
} from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Label, Screen } from '../src/components/ui';
import { PhotoMap } from '../src/components/PhotoMap';
import { saveProperty } from '../src/db/repos';
import { uid } from '../src/utils/format';
import { font, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Review every inference. Nothing the app detects is final: tap to select, then
 * move, retype, set crop, or dismiss (restorable). Add what the photo can't show:
 * bedding you know about, where you park, your existing stands, the boundary.
 */
type Mode = { kind: 'select' } | { kind: 'move'; id: string } | { kind: 'add'; type: FeatureType | 'stand' } | { kind: 'boundary'; points: Vec[] };

const ADDABLE: Array<{ type: FeatureType | 'stand'; label: string }> = [
  { type: 'stand', label: '+ My stand' },
  { type: 'bedding', label: '+ Bedding' },
  { type: 'access_point', label: '+ Parking/access' },
  { type: 'saddle', label: '+ Saddle' },
  { type: 'funnel', label: '+ Funnel' },
  { type: 'creek_crossing', label: '+ Crossing' },
  { type: 'house', label: '+ House' },
];

const CROPS: CropType[] = ['unknown', 'soybeans_green', 'soybeans_standing', 'soybeans_cut', 'corn_standing', 'corn_picked', 'alfalfa_clover', 'winter_wheat', 'brassicas'];

const pretty = (s: string) => s.replace(/_/g, ' ');

export default function Features() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const property = useAppStore((s) => s.activeProperty());
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const [mode, setMode] = useState<Mode>({ kind: 'select' });
  const [selected, setSelected] = useState<string | null>(null);
  const [typePicker, setTypePicker] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const sel = useMemo(() => property?.features.find((f) => f.id === selected) ?? null, [property, selected]);
  if (!property?.calibration || !property.mapImageUri) {
    return (
      <Screen title="Map" onBack={() => router.back()}>
        <View style={{ padding: SPACE }}>
          <Body>No calibrated map yet.</Body>
          <BigButton label="Add property map" onPress={() => router.replace('/calibrate')} />
        </View>
      </Screen>
    );
  }
  const cal = property.calibration;

  const commit = async (next: Property) => {
    const saved = await saveProperty(next);
    upsertProperty(saved);
  };
  const updateFeature = (id: string, patch: (f: MapFeature) => MapFeature) =>
    commit({ ...property, features: property.features.map((f) => (f.id === id ? { ...patch(f), userEdited: true } : f)) });

  const onTap = (px: PixelPoint) => {
    const p = pixelToLocal(cal, px);
    if (mode.kind === 'move') {
      const f = property.features.find((x) => x.id === mode.id);
      const stand = property.stands.find((x) => x.id === mode.id);
      if (f) {
        const delta = sub(p, geometryCentroid(f.geometry));
        void updateFeature(f.id, (x) => ({ ...x, geometry: { ...x.geometry, points: x.geometry.points.map((q) => add(q, delta)) } }));
      } else if (stand) {
        void commit({ ...property, stands: property.stands.map((s) => (s.id === stand.id ? { ...s, position: p } : s)) });
      }
      setMode({ kind: 'select' });
      return;
    }
    if (mode.kind === 'add') {
      if (mode.type === 'stand') {
        const s: Stand = { id: uid('stand'), propertyId: property.id, name: `Stand ${property.stands.length + 1}`, position: p, origin: 'existing', type: 'hang_on' };
        void commit({ ...property, stands: [...property.stands, s] });
      } else {
        const f: MapFeature = {
          id: uid('user'),
          type: mode.type,
          geometry: { kind: 'point', points: [p] },
          confidence: 1,
          source: 'user',
          status: 'active',
          label: pretty(mode.type),
          attributes: mode.type === 'bedding' ? { beddingKind: 'buck' } : undefined,
        };
        void commit({ ...property, features: [...property.features, f] });
        setSelected(f.id);
      }
      setMode({ kind: 'select' });
      return;
    }
    if (mode.kind === 'boundary') {
      setMode({ kind: 'boundary', points: [...mode.points, p] });
      return;
    }
    // Select the nearest feature (inside a polygon counts as 0 m), within a finger's width.
    const reachM = 24 * cal.metersPerPixel * Math.max(1, cal.imageWidth / width);
    let best: { id: string; d: number } | null = null;
    for (const f of property.features) {
      if (f.status !== 'active' && !showDismissed) continue;
      // Points and lines win ties over the polygons they sit inside.
      const d = pointGeometryDistance(p, f.geometry) + (f.geometry.kind === 'polygon' ? reachM * 0.5 : 0);
      if (d < reachM && (!best || d < best.d)) best = { id: f.id, d };
    }
    setSelected(best?.id ?? null);
  };

  const mapH = height * 0.48;
  const banner =
    mode.kind === 'move'
      ? 'Tap the new location'
      : mode.kind === 'add'
        ? `Tap to place: ${mode.type === 'stand' ? 'your stand' : pretty(mode.type)}`
        : mode.kind === 'boundary'
          ? `Tap boundary corners (${mode.points.length}). Press Done when finished.`
          : null;

  return (
    <Screen title={`${property.name} map`} onBack={() => router.back()} scroll={false}>
      <PhotoMap
        imageUri={property.mapImageUri}
        calibration={cal}
        width={width}
        maxHeight={mapH}
        features={property.features}
        showDismissed={showDismissed}
        selectedFeatureId={selected}
        stands={property.stands.filter((s) => !s.dismissed).map((s) => ({ id: s.id, position: s.position, label: s.name, existing: true, selected: s.id === selected }))}
        pins={mode.kind === 'boundary' ? mode.points.map((p, i) => ({ pixel: localToPixel(cal, p), label: String(i + 1) })) : undefined}
        onPressPixel={onTap}
        onPressFeature={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
        onPressStand={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
      />
      {banner ? (
        <View style={{ backgroundColor: t.accent, padding: 10 }}>
          <Text style={{ color: t.accentText, fontWeight: '800', textAlign: 'center' }}>{banner}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }}>
        {sel ? (
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, backgroundColor: t.surface }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>
              {sel.label ?? pretty(sel.type)} <Text style={{ color: t.textDim, fontSize: font.sm }}>({pretty(sel.type)})</Text>
            </Text>
            <Text style={{ color: t.textDim, fontSize: font.sm }}>
              {sel.source === 'user' ? 'Added by you' : `Detected · ${Math.round(sel.confidence * 100)}% confidence`}
              {sel.status === 'dismissed' ? ' · DISMISSED' : ''}
            </Text>
            {sel.rationale ? <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 4 }}>{sel.rationale}</Text> : null}
            {sel.attributes?.crossCheck?.map((c, i) => (
              <Text key={i} style={{ color: c.agrees === false ? t.status.caution : t.textDim, fontSize: font.sm }}>
                {c.source}: {c.detail}
              </Text>
            ))}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <BigButton label="Move" kind="secondary" onPress={() => setMode({ kind: 'move', id: sel.id })} style={{ flexGrow: 1 }} />
              <BigButton label="Change type" kind="secondary" onPress={() => setTypePicker(true)} style={{ flexGrow: 1 }} />
              {sel.status === 'active' ? (
                <BigButton label="Dismiss" kind="ghost" onPress={() => updateFeature(sel.id, (f) => ({ ...f, status: 'dismissed' }))} style={{ flexGrow: 1 }} />
              ) : (
                <BigButton label="Restore" kind="ghost" onPress={() => updateFeature(sel.id, (f) => ({ ...f, status: 'active' }))} style={{ flexGrow: 1 }} />
              )}
            </View>
            {sel.type === 'bedding' ? (
              <>
                <Label>WHOSE BEDDING?</Label>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {(['buck', 'doe', 'unknown'] as const).map((k) => (
                    <BigButton key={k} label={k} kind={sel.attributes?.beddingKind === k ? 'primary' : 'secondary'} onPress={() => updateFeature(sel.id, (f) => ({ ...f, attributes: { ...f.attributes, beddingKind: k } }))} style={{ flex: 1 }} />
                  ))}
                </View>
              </>
            ) : null}
            {sel.type === 'ag_field' || sel.type === 'food_plot' ? (
              <>
                <Label>CROP (matters a lot for food pull by phase)</Label>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {CROPS.map((c) => (
                    <Pressable
                      key={c}
                      onPress={() => updateFeature(sel.id, (f) => ({ ...f, attributes: { ...f.attributes, crop: c } }))}
                      style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 10, borderWidth: 1.5, borderColor: (sel.attributes?.crop ?? 'unknown') === c ? t.accent : t.border }}
                    >
                      <Text style={{ color: t.text, fontSize: font.sm }}>{pretty(c)}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        ) : selected && property.stands.some((s) => s.id === selected) ? (
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, backgroundColor: t.surface }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>{property.stands.find((s) => s.id === selected)?.name}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton label="Move" kind="secondary" onPress={() => setMode({ kind: 'move', id: selected })} style={{ flex: 1 }} />
              <BigButton
                label="Remove"
                kind="ghost"
                onPress={() => commit({ ...property, stands: property.stands.map((s) => (s.id === selected ? { ...s, dismissed: true } : s)) })}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : (
          <Body dim>Tap any feature to review it. Confidence and USGS cross-checks are shown for detections.</Body>
        )}

        <Label>ADD WHAT YOU KNOW</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {ADDABLE.map((a) => (
            <Pressable
              key={a.type}
              accessibilityRole="button"
              onPress={() => setMode({ kind: 'add', type: a.type })}
              style={{ minHeight: TOUCH, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border }}
            >
              <Text style={{ color: t.text, fontWeight: '700' }}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
        {mode.kind === 'boundary' ? (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <BigButton
              label="Done"
              disabled={mode.points.length < 3}
              onPress={() => {
                void commit({ ...property, boundary: mode.points });
                setMode({ kind: 'select' });
              }}
              style={{ flex: 1 }}
            />
            <BigButton label="Cancel" kind="ghost" onPress={() => setMode({ kind: 'select' })} style={{ flex: 1 }} />
          </View>
        ) : (
          <BigButton label={property.boundary?.length ? 'Redraw property boundary' : 'Draw property boundary'} kind="secondary" onPress={() => setMode({ kind: 'boundary', points: [] })} />
        )}
        <BigButton label={showDismissed ? 'Hide dismissed' : 'Show dismissed'} kind="ghost" onPress={() => setShowDismissed((v) => !v)} />
        {property.dismissedCandidatePositions?.length ? (
          <BigButton
            label={`Restore ${property.dismissedCandidatePositions.length} dismissed stand spot(s)`}
            kind="ghost"
            onPress={() =>
              Alert.alert('Restore dismissed stands?', 'The planner may propose stands there again.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Restore', onPress: () => void commit({ ...property, dismissedCandidatePositions: [] }) },
              ])
            }
          />
        ) : null}
        <BigButton label="Done: plan a hunt" onPress={() => router.replace('/plan')} style={{ marginTop: SPACE }} />
      </ScrollView>

      <Modal visible={typePicker} transparent animationType="fade" onRequestClose={() => setTypePicker(false)}>
        <Pressable style={{ flex: 1, backgroundColor: '#000A', justifyContent: 'center', padding: 24 }} onPress={() => setTypePicker(false)}>
          <View style={{ backgroundColor: t.surface, borderRadius: 16, padding: 12, maxHeight: '80%' }}>
            <ScrollView>
              {FEATURE_TYPES.map((ft) => (
                <Pressable
                  key={ft}
                  onPress={() => {
                    if (sel) void updateFeature(sel.id, (f) => ({ ...f, type: ft, confidence: Math.max(f.confidence, 0.9) }));
                    setTypePicker(false);
                  }}
                  style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: t.border }}
                >
                  <Text style={{ color: sel?.type === ft ? t.accent : t.text, fontSize: font.md }}>{pretty(ft)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}


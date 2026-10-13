import React, { useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import {
  FEATURE_TYPES,
  add,
  dist,
  geometryCentroid,
  localToPixel,
  pixelToLocal,
  pointGeometryDistance,
  sub,
  type AccessConstraint,
  type Camera,
  type CropType,
  type FeatureType,
  type Geometry,
  type GeometryKind,
  type MapFeature,
  type PixelPoint,
  type Property,
  type Stand,
  type Vec,
} from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Chip, Label, Screen } from '../src/components/ui';
import { PhotoMap } from '../src/components/PhotoMap';
import { saveProperty } from '../src/db/repos';
import { uid } from '../src/utils/format';
import { font, SPACE, TOUCH } from '../src/theme/theme';

/**
 * Review every inference. Nothing the app detects is final: tap to select, then
 * move, retype, set crop, or dismiss (restorable). Add what the photo can't show:
 * bedding you know about, food the photo missed, roads, where you park, no-access
 * ground, trail cameras, your existing stands, the boundary.
 */
interface AddSpec {
  key: string;
  label: string;
  /** What gets created. */
  target: 'stand' | 'camera' | 'feature' | 'constraint' | 'boundary';
  /** Point: one tap. Line and polygon: tap each vertex, then Done. */
  shape: GeometryKind;
  type?: FeatureType;
  kind?: AccessConstraint['kind'];
  /** Short noun for banners and default names. */
  noun: string;
}

type Mode = { kind: 'select' } | { kind: 'move'; id: string } | { kind: 'add'; spec: AddSpec } | { kind: 'draw'; spec: AddSpec; points: Vec[] };

const POINT_ADDS: AddSpec[] = [
  { key: 'stand', label: '+ My stand', target: 'stand', shape: 'point', noun: 'your stand' },
  { key: 'camera', label: '+ Trail camera', target: 'camera', shape: 'point', noun: 'trail camera' },
  { key: 'bedding', label: '+ Bedding', target: 'feature', type: 'bedding', shape: 'point', noun: 'bedding' },
  { key: 'access_point', label: '+ Parking/access', target: 'feature', type: 'access_point', shape: 'point', noun: 'parking or access point' },
  { key: 'gate', label: '+ Gate (must use)', target: 'constraint', kind: 'must_use_gate', shape: 'point', noun: 'gate you must use' },
  { key: 'saddle', label: '+ Saddle', target: 'feature', type: 'saddle', shape: 'point', noun: 'saddle' },
  { key: 'funnel', label: '+ Funnel', target: 'feature', type: 'funnel', shape: 'point', noun: 'funnel' },
  { key: 'creek_crossing', label: '+ Crossing', target: 'feature', type: 'creek_crossing', shape: 'point', noun: 'creek crossing' },
  { key: 'house', label: '+ House', target: 'feature', type: 'house', shape: 'point', noun: 'house' },
];

const SHAPE_ADDS: AddSpec[] = [
  { key: 'ag_field', label: '+ Ag field', target: 'feature', type: 'ag_field', shape: 'polygon', noun: 'ag field' },
  { key: 'food_plot', label: '+ Food plot', target: 'feature', type: 'food_plot', shape: 'polygon', noun: 'food plot' },
  { key: 'mast_timber', label: '+ Oak / mast timber', target: 'feature', type: 'mast_timber', shape: 'polygon', noun: 'mast timber' },
  { key: 'road', label: '+ Road', target: 'feature', type: 'road', shape: 'line', noun: 'road' },
  { key: 'no_access', label: '+ No-access zone', target: 'constraint', kind: 'no_access_zone', shape: 'polygon', noun: 'no-access zone' },
  { key: 'neighbor_line', label: '+ Neighbor line', target: 'constraint', kind: 'neighbor_line', shape: 'line', noun: 'neighbor line' },
];

const BOUNDARY: AddSpec = { key: 'boundary', label: 'Property boundary', target: 'boundary', shape: 'polygon', noun: 'property boundary' };

/** Every crop the engine understands. 'corn' and 'soybeans' mean the crop is known but its stage is not. */
const CROPS: CropType[] = ['unknown', 'corn', 'soybeans', 'corn_standing', 'corn_picked', 'soybeans_green', 'soybeans_standing', 'soybeans_cut', 'alfalfa_clover', 'winter_wheat', 'brassicas'];
const CROP_LABEL: Partial<Record<CropType, string>> = {
  corn: 'corn (stage unknown)',
  soybeans: 'soybeans (stage unknown)',
};

const CONSTRAINT_LABEL: Record<AccessConstraint['kind'], string> = {
  no_access_zone: 'No-access zone',
  must_use_gate: 'Gate you must use',
  neighbor_line: 'Neighbor line',
  other: 'Restricted',
};
const CONSTRAINT_HELP: Record<AccessConstraint['kind'], string> = {
  no_access_zone: 'Routes go around it and no stand is placed inside it.',
  must_use_gate: 'Every walk in and out starts at this gate.',
  neighbor_line: 'Routes stay on your side of this line.',
  other: 'Routes avoid it.',
};

const pretty = (s: string) => s.replace(/_/g, ' ');
const minPoints = (spec: AddSpec) => (spec.shape === 'polygon' ? 3 : 2);

export default function Features() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const property = useAppStore((s) => s.activeProperty());
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const [mode, setMode] = useState<Mode>({ kind: 'select' });
  const [selected, setSelected] = useState<string | null>(null);
  const [typePicker, setTypePicker] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  /** Saves run one after another, each on top of the last, so quick taps never overwrite each other. */
  const queue = useRef<Promise<void>>(Promise.resolve());

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
  const cameras = property.cameras ?? [];
  const constraints = property.accessConstraints ?? [];
  const selStand = property.stands.find((s) => s.id === selected) ?? null;
  const selCamera = cameras.find((c) => c.id === selected) ?? null;
  const selConstraint = constraints.find((c) => c.id === selected) ?? null;
  const removedStands = property.stands.filter((s) => s.dismissed);

  /** Applies a change to the latest saved property and stores it. Failures are shown, not swallowed. */
  const commit = (change: (p: Property) => Property): void => {
    const run = (queue.current ?? Promise.resolve()).then(async () => {
      const base = useAppStore.getState().properties.find((p) => p.id === property.id) ?? property;
      upsertProperty(await saveProperty(change(base)));
    });
    queue.current = run.catch(() => undefined);
    run.catch((e: unknown) => Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.'));
  };
  const updateFeature = (id: string, patch: (f: MapFeature) => MapFeature) =>
    commit((p) => ({ ...p, features: p.features.map((f) => (f.id === id ? { ...patch(f), userEdited: true } : f)) }));
  const setStandDismissed = (id: string, dismissed: boolean) => commit((p) => ({ ...p, stands: p.stands.map((s) => (s.id === id ? { ...s, dismissed } : s)) }));

  const shift = (g: Geometry, to: Vec): Geometry => {
    const delta = sub(to, geometryCentroid(g));
    return { ...g, points: g.points.map((q) => add(q, delta)) };
  };

  const moveTo = (id: string, p: Vec) => {
    const f = property.features.find((x) => x.id === id);
    if (f) return updateFeature(f.id, (x) => ({ ...x, geometry: shift(x.geometry, p) }));
    if (property.stands.some((x) => x.id === id)) return commit((q) => ({ ...q, stands: q.stands.map((s) => (s.id === id ? { ...s, position: p } : s)) }));
    if (cameras.some((x) => x.id === id)) return commit((q) => ({ ...q, cameras: (q.cameras ?? []).map((c) => (c.id === id ? { ...c, position: p } : c)) }));
    if (constraints.some((x) => x.id === id)) return commit((q) => ({ ...q, accessConstraints: (q.accessConstraints ?? []).map((c) => (c.id === id ? { ...c, geometry: shift(c.geometry, p) } : c)) }));
  };

  /** Creates what `spec` describes from its tapped points, and selects it. */
  const create = (spec: AddSpec, points: Vec[]) => {
    const geometry: Geometry = { kind: spec.shape, points };
    if (spec.target === 'boundary') {
      commit((p) => ({ ...p, boundary: points }));
      return;
    }
    if (spec.target === 'stand') {
      const s: Stand = { id: uid('stand'), propertyId: property.id, name: `Stand ${property.stands.length + 1}`, position: points[0], origin: 'existing', type: 'hang_on' };
      commit((p) => ({ ...p, stands: [...p.stands, s] }));
      setSelected(s.id);
    } else if (spec.target === 'camera') {
      const c: Camera = { id: uid('cam'), propertyId: property.id, name: `Camera ${cameras.length + 1}`, position: points[0] };
      commit((p) => ({ ...p, cameras: [...(p.cameras ?? []), c] }));
      setSelected(c.id);
    } else if (spec.target === 'constraint') {
      const c: AccessConstraint = { id: uid('zone'), kind: spec.kind ?? 'other', geometry, note: spec.kind === 'must_use_gate' ? 'Gate' : undefined };
      commit((p) => ({ ...p, accessConstraints: [...(p.accessConstraints ?? []), c] }));
      setSelected(c.id);
    } else if (spec.type) {
      const f: MapFeature = {
        id: uid('user'),
        type: spec.type,
        geometry,
        confidence: 1,
        source: 'user',
        status: 'active',
        label: pretty(spec.type),
        attributes: spec.type === 'bedding' ? { beddingKind: 'buck' } : undefined,
      };
      commit((p) => ({ ...p, features: [...p.features, f] }));
      setSelected(f.id);
    }
  };

  const startAdd = (spec: AddSpec) => {
    setSelected(null);
    setMode(spec.shape === 'point' ? { kind: 'add', spec } : { kind: 'draw', spec, points: [] });
  };

  const finishDraw = () => {
    if (mode.kind !== 'draw' || mode.points.length < minPoints(mode.spec)) return;
    create(mode.spec, mode.points);
    setMode({ kind: 'select' });
  };

  const onTap = (px: PixelPoint) => {
    const p = pixelToLocal(cal, px);
    if (mode.kind === 'move') {
      moveTo(mode.id, p);
      setMode({ kind: 'select' });
      return;
    }
    if (mode.kind === 'add') {
      create(mode.spec, [p]);
      setMode({ kind: 'select' });
      return;
    }
    if (mode.kind === 'draw') {
      setMode({ ...mode, points: [...mode.points, p] });
      return;
    }
    // Select the nearest thing (inside a polygon counts as 0 m), within a finger's width.
    const reachM = 24 * cal.metersPerPixel * Math.max(1, cal.imageWidth / width);
    let best: { id: string; d: number } | null = null;
    const consider = (id: string, d: number) => {
      if (d < reachM && (!best || d < best.d)) best = { id, d };
    };
    for (const f of property.features) {
      if (f.status !== 'active' && !showDismissed) continue;
      // Points and lines win ties over the polygons they sit inside.
      consider(f.id, pointGeometryDistance(p, f.geometry) + (f.geometry.kind === 'polygon' ? reachM * 0.5 : 0));
    }
    for (const s of property.stands) if (!s.dismissed || showDismissed) consider(s.id, dist(p, s.position));
    for (const c of cameras) consider(c.id, dist(p, c.position));
    for (const c of constraints) consider(c.id, pointGeometryDistance(p, c.geometry) + (c.geometry.kind === 'polygon' ? reachM * 0.5 : 0));
    setSelected((best as { id: string } | null)?.id ?? null);
  };

  const confirmRemove = (title: string, message: string, action: string, onConfirm: () => void) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: 'destructive', onPress: onConfirm },
    ]);

  const mapH = height * 0.48;
  const banner =
    mode.kind === 'move'
      ? 'Tap the new location'
      : mode.kind === 'add'
        ? `Tap to place: ${mode.spec.noun}`
        : mode.kind === 'draw'
          ? `${mode.spec.shape === 'polygon' ? 'Tap each corner' : 'Tap along it'} of the ${mode.spec.noun} (${mode.points.length} so far, need ${minPoints(mode.spec)}). Then press Done.`
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
        stands={property.stands
          .filter((s) => !s.dismissed || showDismissed)
          .map((s) => ({ id: s.id, position: s.position, label: s.name, existing: true, selected: s.id === selected, dimmed: !!s.dismissed }))}
        cameras={cameras.map((c) => ({ id: c.id, position: c.position, label: c.name, selected: c.id === selected }))}
        constraints={constraints}
        selectedConstraintId={selected}
        draft={mode.kind === 'draw' ? { points: mode.points, closed: mode.spec.shape === 'polygon' } : undefined}
        pins={mode.kind === 'draw' ? mode.points.map((p, i) => ({ pixel: localToPixel(cal, p), label: String(i + 1) })) : undefined}
        onPressPixel={onTap}
        onPressFeature={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
        onPressStand={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
        onPressCamera={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
        onPressConstraint={mode.kind === 'select' ? (id) => setSelected(id) : undefined}
      />
      {banner ? (
        <View style={{ backgroundColor: t.accent, padding: 10 }}>
          <Text style={{ color: t.accentText, fontWeight: '800', textAlign: 'center' }}>{banner}</Text>
        </View>
      ) : null}
      {mode.kind === 'draw' ? (
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: SPACE }}>
          <BigButton label="Undo" kind="secondary" disabled={mode.points.length === 0} onPress={() => setMode({ ...mode, points: mode.points.slice(0, -1) })} style={{ flex: 1 }} />
          <BigButton label="Done" disabled={mode.points.length < minPoints(mode.spec)} onPress={finishDraw} style={{ flex: 1 }} />
          <BigButton label="Cancel" kind="ghost" onPress={() => setMode({ kind: 'select' })} style={{ flex: 1 }} />
        </View>
      ) : mode.kind !== 'select' ? (
        <View style={{ paddingHorizontal: SPACE }}>
          <BigButton label="Cancel" kind="ghost" onPress={() => setMode({ kind: 'select' })} />
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
                    <Chip
                      key={c}
                      label={CROP_LABEL[c] ?? pretty(c)}
                      selected={(sel.attributes?.crop ?? 'unknown') === c}
                      onPress={() => updateFeature(sel.id, (f) => ({ ...f, attributes: { ...f.attributes, crop: c } }))}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </View>
        ) : selStand ? (
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, backgroundColor: t.surface }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>
              {selStand.name} <Text style={{ color: t.textDim, fontSize: font.sm }}>{selStand.dismissed ? '(removed)' : '(your stand)'}</Text>
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton label="Move" kind="secondary" onPress={() => setMode({ kind: 'move', id: selStand.id })} style={{ flex: 1 }} />
              {selStand.dismissed ? (
                <BigButton label="Restore" kind="secondary" onPress={() => setStandDismissed(selStand.id, false)} style={{ flex: 1 }} />
              ) : (
                <BigButton
                  label="Remove"
                  kind="ghost"
                  onPress={() => confirmRemove(`Remove ${selStand.name}?`, 'Plans will stop using it. You can bring it back from “Removed stands” below.', 'Remove', () => setStandDismissed(selStand.id, true))}
                  style={{ flex: 1 }}
                />
              )}
            </View>
          </View>
        ) : selCamera ? (
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, backgroundColor: t.surface }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>
              {selCamera.name} <Text style={{ color: t.textDim, fontSize: font.sm }}>(trail camera)</Text>
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton label="Move" kind="secondary" onPress={() => setMode({ kind: 'move', id: selCamera.id })} style={{ flex: 1 }} />
              <BigButton
                label="Delete"
                kind="ghost"
                onPress={() => confirmRemove(`Delete ${selCamera.name}?`, 'The camera is removed from the map.', 'Delete', () => commit((p) => ({ ...p, cameras: (p.cameras ?? []).filter((c) => c.id !== selCamera.id) })))}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : selConstraint ? (
          <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 12, backgroundColor: t.surface }}>
            <Text style={{ color: t.text, fontSize: font.lg, fontWeight: '800' }}>{CONSTRAINT_LABEL[selConstraint.kind]}</Text>
            <Text style={{ color: t.textDim, fontSize: font.sm }}>{CONSTRAINT_HELP[selConstraint.kind]}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton label="Move" kind="secondary" onPress={() => setMode({ kind: 'move', id: selConstraint.id })} style={{ flex: 1 }} />
              <BigButton
                label="Delete"
                kind="ghost"
                onPress={() =>
                  confirmRemove(`Delete this ${CONSTRAINT_LABEL[selConstraint.kind].toLowerCase()}?`, 'Routes and stands will ignore it from now on.', 'Delete', () =>
                    commit((p) => ({ ...p, accessConstraints: (p.accessConstraints ?? []).filter((c) => c.id !== selConstraint.id) })),
                  )
                }
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : (
          <Body dim>Tap any feature to review it. Confidence and USGS cross-checks are shown for detections.</Body>
        )}

        <Label>PLACE A POINT</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {POINT_ADDS.map((a) => (
            <AddButton key={a.key} spec={a} onPress={startAdd} />
          ))}
        </View>
        <Label>DRAW AN AREA OR LINE</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {SHAPE_ADDS.map((a) => (
            <AddButton key={a.key} spec={a} onPress={startAdd} />
          ))}
        </View>
        <Body dim style={{ marginTop: 6 }}>
          Food the photo missed, roads, and ground you can’t walk change which stands are safe and where shots are never taken.
        </Body>

        <BigButton label={property.boundary?.length ? 'Redraw property boundary' : 'Draw property boundary'} kind="secondary" onPress={() => startAdd(BOUNDARY)} />

        {removedStands.length ? (
          <>
            <Label>REMOVED STANDS</Label>
            {removedStands.map((s) => (
              <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TOUCH }}>
                <Text style={{ color: t.text, fontSize: font.md, flex: 1 }}>{s.name}</Text>
                <BigButton label="Restore" kind="secondary" onPress={() => setStandDismissed(s.id, false)} accessibilityHint={`Puts ${s.name} back in your plans`} />
              </View>
            ))}
          </>
        ) : null}

        <BigButton label={showDismissed ? 'Hide dismissed' : 'Show dismissed'} kind="ghost" onPress={() => setShowDismissed((v) => !v)} />
        {property.dismissedCandidatePositions?.length ? (
          <BigButton
            label={`Restore ${property.dismissedCandidatePositions.length} dismissed stand spot(s)`}
            kind="ghost"
            onPress={() =>
              Alert.alert('Restore dismissed stands?', 'The planner may propose stands there again.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Restore', onPress: () => commit((p) => ({ ...p, dismissedCandidatePositions: [] })) },
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
                  accessibilityRole="button"
                  onPress={() => {
                    if (sel) updateFeature(sel.id, (f) => ({ ...f, type: ft, confidence: Math.max(f.confidence, 0.9) }));
                    setTypePicker(false);
                  }}
                  style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: t.border }}
                >
                  <Text style={{ color: sel?.type === ft ? t.accent : t.text, fontSize: font.md }}>
                    {sel?.type === ft ? '✓ ' : ''}
                    {pretty(ft)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function AddButton({ spec, onPress }: { spec: AddSpec; onPress: (s: AddSpec) => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spec.label.replace(/^\+ /, 'Add ')}
      onPress={() => onPress(spec)}
      style={{ minHeight: TOUCH, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, backgroundColor: t.surfaceAlt, borderWidth: 1, borderColor: t.border }}
    >
      <Text style={{ color: t.text, fontWeight: '700' }}>{spec.label}</Text>
    </Pressable>
  );
}

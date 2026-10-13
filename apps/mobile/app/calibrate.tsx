import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import {
  calibrationFromNorthAndScale,
  calibrationFromTwoPoints,
  crossCheckFeatures,
  describeScale,
  dist,
  geoToLocal,
  isInUS,
  localToGeo,
  metersPerDegree,
  pixelToLocal,
  referenceResiduals,
  scaleFromKnownDistance,
  visionToFeatures,
  type Calibration,
  type LatLon,
  type MapFeature,
  type PixelPoint,
  type Property,
  type ReferencePoint,
  type VisionResponse,
} from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Field, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { PhotoMap } from '../src/components/PhotoMap';
import { StatusIcon, WindArrow } from '../src/components/Icons';
import { analyzePhoto } from '../src/services/vision';
import { createLandDataProvider } from '../src/services/landdata';
import { currentLocation } from '../src/services/device';
import { saveProperty, setSetting } from '../src/db/repos';
import { todayLocal, uid } from '../src/utils/format';
import { font, SPACE } from '../src/theme/theme';

/**
 * Map-photo calibration:
 *   1. Photo + name   2. North   3. Scale (scale bar)   4. Two reference points   5. Map features
 * Steps 2–3 can be skipped if two geo-referenced points are given (they determine both).
 *
 * With `?anchor=<propertyId>` it adds coordinates to an existing photo-only map instead:
 * one known point pins the map's existing north and scale to the ground, so every
 * stand, feature and sighting already on it stays exactly where it is.
 */
type Step = 'photo' | 'north' | 'scale' | 'refs' | 'analyze';
const UNITS = ['ft', 'yd', 'mi', 'm'] as const;
const TO_M: Record<(typeof UNITS)[number], number> = { ft: 0.3048, yd: 0.9144, mi: 1609.344, m: 1 };
/** A second anchor point farther than this from where north + scale put it means one of them is off. */
const ANCHOR_CHECK_M = 30;

interface Photo {
  uri: string;
  width: number;
  height: number;
}

const msg = (e: unknown, fallback = 'Unknown error') => (e instanceof Error ? e.message : fallback);

/** Mock detections are a made-up farm: say so on every feature, everywhere it is shown. */
function markSample(features: MapFeature[]): MapFeature[] {
  return features.map((f) => ({
    ...f,
    label: `Sample: ${f.label ?? f.type.replace(/_/g, ' ')}`,
    rationale: `Mock analysis: made-up sample, not detected in your photo.${f.rationale ? ` ${f.rationale}` : ''}`,
  }));
}

/**
 * Geo-references an existing north + scale calibration without changing its local frame:
 * the origin pixel, rotation and scale stay, and only originGeo is solved from the first
 * point with coordinates. A second point is used as a check.
 */
function anchorCalibration(base: Calibration, refs: ReferencePoint[]): { cal: Calibration | null; error?: string } {
  const geoRefs = refs.filter((r) => r?.geo);
  if (!geoRefs.length) return { cal: null, error: 'Give coordinates for at least one point.' };
  const g = geoRefs[0].geo as LatLon;
  const l0 = pixelToLocal(base, geoRefs[0].pixel);
  // Origin = the point's coordinates minus its offset from the origin (one refinement for latitude).
  const first = localToGeo({ x: -l0.x, y: -l0.y }, g);
  const m = metersPerDegree(first.lat);
  const originGeo = { lat: g.lat - l0.y / m.lat, lon: g.lon - l0.x / m.lon };
  const warnings: string[] = [];
  if (!isInUS(originGeo)) warnings.push('Reference coordinates are outside the US. US data sources will not be available.');
  const second = geoRefs[1];
  if (second?.geo) {
    const off = dist(pixelToLocal(base, second.pixel), geoToLocal(second.geo, originGeo));
    if (off > ANCHOR_CHECK_M) {
      warnings.push(`Point 2 lands ${Math.round(off)} m from where this map's north and scale put it. Check both points; if they are right, the north arrow or scale bar was off and the map needs a fresh calibration.`);
    }
  }
  return { cal: { ...base, originGeo, referencePoints: refs.filter(Boolean), warnings } };
}

export default function Calibrate() {
  const t = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const { anchor } = useLocalSearchParams<{ anchor?: string }>();
  const anchorProperty = useAppStore((s) => (anchor ? s.properties.find((p) => p.id === anchor) ?? null : null));
  const anchorBase = anchorProperty?.calibration && anchorProperty.mapImageUri ? anchorProperty.calibration : null;
  const settings = useAppStore((s) => s.settings);
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const set = useAppStore((s) => s.set);

  const [step, setStep] = useState<Step>(() => (anchorBase ? 'refs' : 'photo'));
  const [photo, setPhoto] = useState<Photo | null>(() =>
    anchorBase && anchorProperty?.mapImageUri ? { uri: anchorProperty.mapImageUri, width: anchorBase.imageWidth, height: anchorBase.imageHeight } : null,
  );
  const [name, setName] = useState('');
  const [stateCode, setStateCode] = useState('IA');
  const [north, setNorth] = useState(() => anchorBase?.northRotationDeg ?? 0);
  const [scalePts, setScalePts] = useState<PixelPoint[]>([]);
  const [scaleValue, setScaleValue] = useState('');
  const [scaleUnit, setScaleUnit] = useState<(typeof UNITS)[number]>('ft');
  const [refs, setRefs] = useState<ReferencePoint[]>([]);
  const [activeRef, setActiveRef] = useState<0 | 1>(0);
  const [latText, setLatText] = useState('');
  const [lonText, setLonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const mapW = screenW - SPACE * 2;
  const mapH = screenH * 0.42;
  const mock = settings.visionMode === 'mock';

  const pickPhoto = async (camera: boolean) => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permission needed', camera ? 'Allow camera access to photograph a map.' : 'Allow photo access to pick a map screenshot.');
    const r = camera ? await ImagePicker.launchCameraAsync({ quality: 0.9 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    // Keep the photo inside the app sandbox (it never leaves the phone).
    const dir = `${FileSystem.documentDirectory}maps/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    const dest = `${dir}${uid('map')}.jpg`;
    await FileSystem.copyAsync({ from: a.uri, to: dest });
    setPhoto({ uri: dest, width: a.width, height: a.height });
  };

  const metersPerPixel = useMemo(() => {
    const v = Number(scaleValue);
    if (scalePts.length !== 2 || !(v > 0)) return undefined;
    try {
      return scaleFromKnownDistance(scalePts[0], scalePts[1], v * TO_M[scaleUnit]);
    } catch {
      return undefined;
    }
  }, [scalePts, scaleValue, scaleUnit]);

  /** The calibration so far, or why there is none yet (shown to the hunter, never swallowed). */
  const { calibration, calError } = useMemo((): { calibration: Calibration | null; calError?: string } => {
    if (!photo) return { calibration: null };
    if (anchorBase) {
      const a = anchorCalibration(anchorBase, refs);
      return { calibration: a.cal, calError: a.error };
    }
    // `refs` can have a hole when Point 2 is placed first: work only with the points that exist.
    const placed = refs.filter(Boolean);
    const geoRefs = placed.filter((r) => r.geo);
    let twoPointError: string | undefined;
    if (geoRefs.length >= 2) {
      try {
        return {
          calibration: calibrationFromTwoPoints({
            imageWidth: photo.width,
            imageHeight: photo.height,
            refs: [geoRefs[0], geoRefs[1]],
            estimatedNorthDeg: north,
            estimatedMetersPerPixel: metersPerPixel,
          }),
        };
      } catch (e) {
        twoPointError = msg(e);
      }
    }
    if (metersPerPixel) {
      try {
        const cal = calibrationFromNorthAndScale({
          imageWidth: photo.width,
          imageHeight: photo.height,
          northRotationDeg: north,
          metersPerPixel,
          originPixel: geoRefs[0]?.pixel,
          originGeo: geoRefs[0]?.geo,
          referencePoints: placed,
        });
        // Two points that cannot be used: fall back to the scale bar and say why.
        return { calibration: twoPointError ? { ...cal, warnings: [...cal.warnings, `Using your north arrow and scale bar, not the two points: ${twoPointError}`] } : cal };
      } catch (e) {
        return { calibration: null, calError: msg(e) };
      }
    }
    return { calibration: null, calError: twoPointError };
  }, [photo, refs, north, metersPerPixel, anchorBase]);

  // A provisional calibration so the photo can be drawn before scale is known.
  const drawCal: Calibration | null = photo
    ? calibration ?? anchorBase ?? calibrationFromNorthAndScale({ imageWidth: photo.width, imageHeight: photo.height, northRotationDeg: north, metersPerPixel: 1 })
    : null;

  const setRefGeo = (geo: LatLon) => {
    setRefs((prev) => prev.map((r, i) => (i === activeRef ? { ...r, geo } : r)));
  };

  const onTap = (p: PixelPoint) => {
    if (step === 'scale') setScalePts((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
    if (step === 'refs') {
      setRefs((prev) => {
        const next = [...prev];
        next[activeRef] = { pixel: p, label: activeRef === 0 ? 'Point 1' : 'Point 2', geo: prev[activeRef]?.geo };
        return next;
      });
    }
  };

  const applyTypedCoords = () => {
    const lat = Number(latText.trim());
    const lon = Number(lonText.trim());
    if (!(lat > 18 && lat < 72) || !(lon < -60 && lon > -180)) return Alert.alert('Check coordinates', 'Enter decimal degrees for a US location, e.g. 41.8512, -93.2987 (west longitude is negative).');
    setRefGeo({ lat, lon });
  };

  const useGps = async () => {
    const g = await currentLocation().catch(() => null);
    if (!g) return Alert.alert('No GPS fix', 'Allow location access, or type the coordinates.');
    setRefGeo(g);
    setLatText(g.lat.toFixed(6));
    setLonText(g.lon.toFixed(6));
  };

  /** Saves the calibrated map as a new property and opens the feature editor. */
  const saveNewProperty = async (id: string, features: MapFeature[], analysisMode: NonNullable<Property['analysisMode']>) => {
    if (!photo || !calibration) return;
    const now = new Date().toISOString();
    const property: Property = {
      id,
      name: name.trim() || 'My property',
      stateCode: stateCode.trim().toUpperCase().slice(0, 2) || 'IA',
      calibration,
      mapImageUri: photo.uri,
      features,
      stands: [],
      cameras: [],
      accessConstraints: [],
      analysisMode,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await saveProperty(property);
    upsertProperty(saved);
    set({ activePropertyId: saved.id });
    await setSetting('activePropertyId', saved.id);
    router.replace('/features');
  };

  /** No analysis: keep the calibration, start with an empty map the hunter fills in. */
  const mapByHand = async () => {
    if (!photo || !calibration) return;
    setBusy(true);
    try {
      await saveNewProperty(uid('prop'), [], 'manual');
    } catch (e) {
      Alert.alert('Could not save the map', msg(e));
    } finally {
      setBusy(false);
    }
  };

  const analyzeAndSave = async () => {
    if (!photo || !calibration) return;
    setBusy(true);
    const id = uid('prop');
    let v: VisionResponse;
    try {
      setProgress(mock ? 'Loading sample features…' : 'Analyzing map photo…');
      v = await analyzePhoto(photo.uri, photo.width, photo.height, settings);
    } catch (e) {
      setBusy(false);
      setProgress('');
      Alert.alert('Analysis failed', `${msg(e)}\n\nYour calibration is kept. Save the map and mark features by hand, or try again.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Try again', onPress: () => void analyzeAndSave() },
        { text: 'Mark by hand', onPress: () => void mapByHand() },
      ]);
      return;
    }
    try {
      const sample = v.mode === 'mock';
      let features = visionToFeatures(v.result, calibration, id);
      if (sample) {
        features = markSample(features);
      } else if (calibration.originGeo) {
        setProgress('Cross-checking with USGS elevation and land cover…');
        features = await crossCheckFeatures(features, calibration, createLandDataProvider(), todayLocal()).catch(() => features);
      }
      await saveNewProperty(id, features, sample ? 'mock' : 'proxy');
      if (sample) {
        Alert.alert('Sample features loaded', 'These are a made-up Midwest farm, not detections from your photo. Each one is labelled "Sample". Dismiss or replace them before you trust a plan.');
      } else {
        const notes = [...v.result.notes, ...v.issues];
        if (notes.length) Alert.alert('Analysis notes', notes.slice(0, 5).join('\n\n'));
      }
    } catch (e) {
      Alert.alert('Could not save the map', msg(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const confirmSample = () =>
    Alert.alert(
      'Load sample features?',
      'This puts a made-up farm (road, house, bedding, food) on your map. It is only for trying the app: a plan built on it says nothing about your property.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Load sample', onPress: () => void analyzeAndSave() },
      ],
    );

  /** Anchor mode: same property, same frame, now with coordinates. */
  const saveAnchor = async () => {
    if (!anchorProperty || !calibration?.originGeo) return;
    setBusy(true);
    try {
      const saved = await saveProperty({ ...anchorProperty, calibration, updatedAt: new Date().toISOString() });
      upsertProperty(saved);
      router.back();
    } catch (e) {
      Alert.alert('Could not save the coordinates', msg(e));
    } finally {
      setBusy(false);
    }
  };

  // Pins keep their real point number even when Point 2 was placed first.
  const pins = [
    ...(step === 'scale' ? scalePts.map((p, i) => ({ pixel: p, label: i === 0 ? 'A' : 'B' })) : []),
    ...(step === 'refs' || step === 'analyze' ? refs.flatMap((r, i) => (r ? [{ pixel: r.pixel, label: `${i + 1}${r.geo ? ' ✓' : ''}` }] : [])) : []),
  ];

  const stepTitle: Record<Step, string> = { photo: '1 · Map photo', north: '2 · North', scale: '3 · Scale', refs: anchorBase ? 'Add coordinates' : '4 · Reference points', analyze: '5 · Map features' };

  return (
    <Screen title={stepTitle[step]} onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {anchor && !anchorBase ? (
          <Card>
            <Body>That map was not found, or it has no calibration yet.</Body>
            <BigButton label="Back" kind="secondary" onPress={() => router.back()} />
          </Card>
        ) : null}

        {photo && drawCal ? (
          <View>
            <PhotoMap
              imageUri={photo.uri}
              calibration={drawCal}
              width={mapW}
              maxHeight={mapH}
              pins={pins}
              features={anchorBase ? anchorProperty?.features : undefined}
              onPressPixel={step === 'scale' || step === 'refs' ? onTap : undefined}
            />
            {step === 'north' ? (
              <View pointerEvents="none" style={{ position: 'absolute', top: 10, left: 10, backgroundColor: t.surface, borderRadius: 12, padding: 6, alignItems: 'center' }}>
                <WindArrow downwindDeg={north} color={t.accent} size={56} />
                <Text style={{ color: t.text, fontWeight: '900' }}>N</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {step === 'photo' ? (
          <>
            <Body dim>Use an aerial, a topo, or an onX/HuntStand screenshot. Zoom so the whole property fills the screen and the scale bar is visible.</Body>
            <BigButton label={photo ? 'Pick a different photo' : 'Pick map screenshot'} onPress={() => pickPhoto(false)} style={{ marginTop: SPACE }} />
            <BigButton label="Photograph a paper map" kind="secondary" onPress={() => pickPhoto(true)} />
            <Field label="Property name" value={name} onChangeText={setName} placeholder="e.g. Ridge Farm" />
            <Field label="State (2 letters)" value={stateCode} onChangeText={setStateCode} autoCapitalize="characters" maxLength={2} />
            <BigButton label="Next: north" disabled={!photo} onPress={() => setStep('north')} style={{ marginTop: SPACE }} />
          </>
        ) : null}

        {step === 'north' ? (
          <>
            <Body dim>App screenshots (onX, HuntStand, Google) are almost always north-up. Rotate only if the map's north arrow points elsewhere.</Body>
            <BigButton label="Map is north-up" onPress={() => { setNorth(0); setStep('scale'); }} style={{ marginTop: SPACE }} />
            <Stepper label="North arrow rotation (clockwise)" value={north} onChange={(v) => setNorth(((v % 360) + 360) % 360)} step={5} min={-360} max={720} unit="°" />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <BigButton label="−1°" kind="secondary" onPress={() => setNorth((n) => (n + 359) % 360)} style={{ flex: 1 }} />
              <BigButton label="+1°" kind="secondary" onPress={() => setNorth((n) => (n + 1) % 360)} style={{ flex: 1 }} />
            </View>
            <BigButton label="Next: scale" onPress={() => setStep('scale')} />
          </>
        ) : null}

        {step === 'scale' ? (
          <>
            <Body dim>Tap both ends of the map's scale bar (A, then B), then enter its length. Or skip this if you'll give two GPS reference points.</Body>
            <Field label="Scale bar length" value={scaleValue} onChangeText={setScaleValue} keyboardType="decimal-pad" placeholder="e.g. 500" />
            <View style={{ marginTop: 8 }}>
              <Segmented options={UNITS} value={scaleUnit} onChange={setScaleUnit} />
            </View>
            {metersPerPixel && calibration ? <Text style={{ color: t.text, marginTop: 8, fontSize: font.sm }}>{describeScale(calibration)}</Text> : null}
            <BigButton label="Next: reference points" onPress={() => setStep('refs')} style={{ marginTop: SPACE }} />
          </>
        ) : null}

        {step === 'refs' && photo ? (
          <>
            <Body dim>
              {anchorBase
                ? 'Tap a spot on this map you can locate (gate, field corner, your stand), then give its coordinates. One point pins the map using the north and scale you already set; a second point far away checks them. Stands and features stay where they are.'
                : 'Tap a spot you can locate (gate, field corner, your stand), then give its coordinates. Two points far apart geo-reference the map and turn on NWS forecasts, elevation thermals and land-cover checks.'}
            </Body>
            <View style={{ marginTop: SPACE }}>
              <Segmented options={['0', '1'] as const} value={String(activeRef) as '0' | '1'} onChange={(v) => { setActiveRef(Number(v) as 0 | 1); setLatText(''); setLonText(''); }} labels={{ '0': `Point 1${refs[0]?.geo ? ' ✓' : ''}`, '1': `Point 2${refs[1]?.geo ? ' ✓' : ''}` }} />
            </View>
            {refs[activeRef] ? (
              <>
                <BigButton label="I'm standing here: use GPS" kind="secondary" onPress={useGps} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Latitude" value={latText} onChangeText={setLatText} keyboardType="numbers-and-punctuation" placeholder="41.85123" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Longitude" value={lonText} onChangeText={setLonText} keyboardType="numbers-and-punctuation" placeholder="-93.29871" />
                  </View>
                </View>
                <BigButton label="Set coordinates" kind="secondary" onPress={applyTypedCoords} />
              </>
            ) : (
              <Card>
                <Body>Tap the photo to place point {activeRef + 1}.</Body>
              </Card>
            )}
            {calibration ? (
              <Card>
                <Text style={{ color: t.text, fontWeight: '800' }}>
                  {calibration.method === 'two_point_geo' ? 'Geo-referenced ✓' : calibration.originGeo ? 'Anchored with one point' : 'Photo only (no coordinates)'}
                </Text>
                <Text style={{ color: t.textDim, fontSize: font.sm }}>{describeScale(calibration)}</Text>
                {referenceResiduals(calibration).length ? <Text style={{ color: t.textDim, fontSize: font.sm }}>Fit error: {Math.max(...referenceResiduals(calibration)).toFixed(1)} m</Text> : null}
                {calibration.warnings.map((w, i) => (
                  <View key={i} style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                    <StatusIcon status="caution" color={t.status.caution} size={16} />
                    <Text style={{ color: t.status.caution, fontSize: font.sm, flex: 1 }}>{w}</Text>
                  </View>
                ))}
                {!calibration.originGeo ? (
                  <Text style={{ color: t.textDim, fontSize: font.sm, marginTop: 6 }}>
                    Without coordinates you can still plan: Plan Hunt asks for your GPS position at the property for sun times, legal hours and the forecast. Elevation and land-cover checks stay off. You can add coordinates later.
                  </Text>
                ) : null}
              </Card>
            ) : (
              <Card>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <StatusIcon status="caution" color={t.status.caution} size={18} />
                  <Text style={{ color: t.status.caution, flex: 1 }}>
                    {calError ?? 'Need either a scale bar (step 3) or two points with coordinates.'}
                    {calError && !anchorBase && !metersPerPixel ? ' Or go back and set the scale bar.' : ''}
                  </Text>
                </View>
              </Card>
            )}
            {anchorBase ? (
              <>
                <BigButton label="Save coordinates" loading={busy} disabled={!calibration?.originGeo} onPress={saveAnchor} />
                <BigButton label="Cancel" kind="ghost" onPress={() => router.back()} />
              </>
            ) : (
              <>
                <BigButton label="Next: map features" disabled={!calibration} onPress={() => setStep('analyze')} />
                <BigButton label="Back to scale" kind="ghost" onPress={() => setStep('scale')} />
              </>
            )}
          </>
        ) : null}

        {step === 'analyze' ? (
          <>
            <Label>MAP FEATURES</Label>
            {mock ? (
              <>
                <Body dim>
                  Vision analysis is in mock mode (no proxy set up in Settings), so the app cannot read your photo. Mark bedding, food, trails, roads and houses yourself: you know your ground best.
                </Body>
                <BigButton label="Mark features by hand" loading={busy} onPress={mapByHand} style={{ marginTop: SPACE }} />
                <BigButton label="Load sample features (demo only)" kind="ghost" disabled={busy} onPress={confirmSample} />
              </>
            ) : (
              <>
                <Body dim>Your photo goes to your vision proxy for analysis. Every detection comes back editable: move, retype or dismiss anything.</Body>
                <BigButton label="Analyze & review" loading={busy} onPress={analyzeAndSave} style={{ marginTop: SPACE }} />
                <BigButton label="Skip: mark features by hand" kind="ghost" disabled={busy} onPress={mapByHand} />
              </>
            )}
            {progress ? <Text style={{ color: t.accent, marginTop: 8 }}>{progress}</Text> : null}
            <BigButton label="Back" kind="ghost" disabled={busy} onPress={() => setStep('refs')} />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

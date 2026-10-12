import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import {
  calibrationFromNorthAndScale,
  calibrationFromTwoPoints,
  crossCheckFeatures,
  describeScale,
  referenceResiduals,
  scaleFromKnownDistance,
  visionToFeatures,
  type Calibration,
  type LatLon,
  type PixelPoint,
  type Property,
  type ReferencePoint,
} from '@msp/engine';
import { useAppStore } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Card, Field, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { PhotoMap } from '../src/components/PhotoMap';
import { WindArrow } from '../src/components/Icons';
import { analyzePhoto } from '../src/services/vision';
import { createLandDataProvider } from '../src/services/landdata';
import { currentLocation } from '../src/services/device';
import { saveProperty, setSetting } from '../src/db/repos';
import { todayLocal, uid } from '../src/utils/format';
import { font, SPACE } from '../src/theme/theme';

/**
 * Map-photo calibration:
 *   1. Photo + name   2. North   3. Scale (scale bar)   4. Two reference points   5. Analyze & review
 * Steps 2–3 can be skipped if two geo-referenced points are given (they determine both).
 */
type Step = 'photo' | 'north' | 'scale' | 'refs' | 'analyze';
const UNITS = ['ft', 'yd', 'mi', 'm'] as const;
const TO_M: Record<(typeof UNITS)[number], number> = { ft: 0.3048, yd: 0.9144, mi: 1609.344, m: 1 };

interface Photo {
  uri: string;
  width: number;
  height: number;
}

export default function Calibrate() {
  const t = useTheme();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const settings = useAppStore((s) => s.settings);
  const upsertProperty = useAppStore((s) => s.upsertProperty);
  const set = useAppStore((s) => s.set);

  const [step, setStep] = useState<Step>('photo');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [name, setName] = useState('');
  const [stateCode, setStateCode] = useState('IA');
  const [north, setNorth] = useState(0);
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

  const calibration: Calibration | null = useMemo(() => {
    if (!photo) return null;
    const geoRefs = refs.filter((r) => r.geo);
    try {
      if (geoRefs.length >= 2) {
        return calibrationFromTwoPoints({
          imageWidth: photo.width,
          imageHeight: photo.height,
          refs: [geoRefs[0], geoRefs[1]],
          estimatedNorthDeg: north,
          estimatedMetersPerPixel: metersPerPixel,
        });
      }
      if (metersPerPixel) {
        return calibrationFromNorthAndScale({
          imageWidth: photo.width,
          imageHeight: photo.height,
          northRotationDeg: north,
          metersPerPixel,
          originPixel: geoRefs[0]?.pixel,
          originGeo: geoRefs[0]?.geo,
          referencePoints: refs,
        });
      }
    } catch (e) {
      return null;
    }
    return null;
  }, [photo, refs, north, metersPerPixel]);

  // A provisional calibration so the photo can be drawn before scale is known.
  const drawCal: Calibration | null = photo
    ? calibration ?? calibrationFromNorthAndScale({ imageWidth: photo.width, imageHeight: photo.height, northRotationDeg: north, metersPerPixel: 1 })
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
    const g = await currentLocation();
    if (!g) return Alert.alert('No GPS fix', 'Allow location access, or type the coordinates.');
    setRefGeo(g);
    setLatText(g.lat.toFixed(6));
    setLonText(g.lon.toFixed(6));
  };

  const analyzeAndSave = async () => {
    if (!photo || !calibration) return;
    setBusy(true);
    try {
      setProgress(settings.visionMode === 'mock' ? 'Running mock analysis…' : 'Analyzing map photo…');
      const v = await analyzePhoto(photo.uri, photo.width, photo.height, settings);
      const id = uid('prop');
      let features = visionToFeatures(v.result, calibration, id);
      if (calibration.originGeo) {
        setProgress('Cross-checking with USGS elevation and land cover…');
        features = await crossCheckFeatures(features, calibration, createLandDataProvider(), todayLocal()).catch(() => features);
      }
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
        createdAt: now,
        updatedAt: now,
      };
      const saved = await saveProperty(property);
      upsertProperty(saved);
      set({ activePropertyId: saved.id });
      await setSetting('activePropertyId', saved.id);
      router.replace('/features');
    } catch (e) {
      Alert.alert('Analysis failed', `${e instanceof Error ? e.message : 'Unknown error'}\n\nYou can switch to mock mode in Settings, or add features by hand.`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const pins = [
    ...(step === 'scale' ? scalePts.map((p, i) => ({ pixel: p, label: i === 0 ? 'A' : 'B' })) : []),
    ...(step === 'refs' || step === 'analyze' ? refs.filter(Boolean).map((r, i) => ({ pixel: r.pixel, label: `${i + 1}${r.geo ? ' ✓' : ''}` })) : []),
  ];

  const stepTitle: Record<Step, string> = { photo: '1 · Map photo', north: '2 · North', scale: '3 · Scale', refs: '4 · Reference points', analyze: '5 · Analyze' };

  return (
    <Screen title={stepTitle[step]} onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {photo && drawCal ? (
          <View>
            <PhotoMap imageUri={photo.uri} calibration={drawCal} width={mapW} maxHeight={mapH} pins={pins} onPressPixel={step === 'scale' || step === 'refs' ? onTap : undefined} />
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

        {step === 'refs' ? (
          <>
            <Body dim>
              Tap a spot you can locate (gate, field corner, your stand), then give its coordinates. Two points far apart geo-reference the map and turn on NWS forecasts, elevation thermals and land-cover checks.
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
                <Text style={{ color: t.text, fontWeight: '800' }}>{calibration.method === 'two_point_geo' ? 'Geo-referenced ✓' : calibration.originGeo ? 'Anchored with one point' : 'Photo only (no coordinates)'}</Text>
                <Text style={{ color: t.textDim, fontSize: font.sm }}>{describeScale(calibration)}</Text>
                {referenceResiduals(calibration).length ? <Text style={{ color: t.textDim, fontSize: font.sm }}>Fit error: {Math.max(...referenceResiduals(calibration)).toFixed(1)} m</Text> : null}
                {calibration.warnings.map((w, i) => (
                  <Text key={i} style={{ color: t.status.caution, fontSize: font.sm, marginTop: 4 }}>
                    ! {w}
                  </Text>
                ))}
              </Card>
            ) : (
              <Card>
                <Text style={{ color: t.status.caution }}>Need either a scale bar (step 3) or two points with coordinates.</Text>
              </Card>
            )}
            <BigButton label="Next: analyze map" disabled={!calibration} onPress={() => setStep('analyze')} />
            <BigButton label="Back to scale" kind="ghost" onPress={() => setStep('scale')} />
          </>
        ) : null}

        {step === 'analyze' ? (
          <>
            <Label>VISION ANALYSIS</Label>
            <Body dim>
              {settings.visionMode === 'mock'
                ? 'Mock mode: shows a sample Midwest farm layout so you can try the app offline. Switch to your vision proxy in Settings for real detections.'
                : 'Your photo goes to your vision proxy for analysis. Every detection comes back editable: move, retype or dismiss anything.'}
            </Body>
            {progress ? <Text style={{ color: t.accent, marginTop: 8 }}>{progress}</Text> : null}
            <BigButton label="Analyze & review" loading={busy} onPress={analyzeAndSave} style={{ marginTop: SPACE }} />
            <BigButton label="Back" kind="ghost" onPress={() => setStep('refs')} />
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

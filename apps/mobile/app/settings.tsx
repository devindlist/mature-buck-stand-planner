import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { DISCLAIMER } from '@msp/engine';
import { useAppStore, type Settings } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Disclaimer, Field, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { setSetting } from '../src/db/repos';
import { wipeAllData } from '../src/db/database';
import { downloadOfflinePack } from '../src/services/offlineMaps';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const redLight = useAppStore((s) => s.redLight);
  const set = useAppStore((s) => s.set);
  const property = useAppStore((s) => s.activeProperty());
  const [pack, setPack] = useState<string | null>(null);

  const update = (patch: Partial<Settings>) => {
    setSettings(patch);
    void setSetting('settings', { ...useAppStore.getState().settings });
  };

  const toggle = (label: string, on: boolean, onPress: () => void, hint?: string) => (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} onPress={onPress} style={{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: t.border }}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={{ color: t.text, fontSize: font.md }}>{label}</Text>
        {hint ? <Text style={{ color: t.textDim, fontSize: font.xs }}>{hint}</Text> : null}
      </View>
      <View style={{ width: 56, height: 32, borderRadius: 16, backgroundColor: on ? t.accent : t.surfaceAlt, justifyContent: 'center', padding: 3 }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.text, alignSelf: on ? 'flex-end' : 'flex-start' }} />
      </View>
    </Pressable>
  );

  const downloadMaps = async () => {
    if (!property) return;
    try {
      setPack('Starting…');
      await downloadOfflinePack(property, 'imageryTopo', (pct) => setPack(`Downloading USGS imagery/topo… ${pct}%`));
      setPack('Offline basemap ready ✓');
    } catch (e) {
      setPack(e instanceof Error ? e.message : 'Download failed');
    }
  };

  return (
    <Screen title="Settings" onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: SPACE, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Label>MAP ANALYSIS</Label>
        <Segmented options={['mock', 'proxy'] as const} value={settings.visionMode} onChange={(v) => update({ visionMode: v })} labels={{ mock: 'Mock (offline demo)', proxy: 'Vision proxy' }} />
        {settings.visionMode === 'proxy' ? (
          <>
            <Field label="Proxy URL" value={settings.proxyUrl} onChangeText={(v) => update({ proxyUrl: v.trim() })} autoCapitalize="none" autoCorrect={false} placeholder="https://your-proxy.example.com" />
            <Field label="App token (from your proxy)" value={settings.appToken} onChangeText={(v) => update({ appToken: v.trim() })} autoCapitalize="none" autoCorrect={false} secureTextEntry />
            <Body dim>Your map photo is sent only to this proxy, which calls Claude. Your API key stays on the server, never on the phone.</Body>
          </>
        ) : null}

        <Label>SAFETY</Label>
        <Field label="Emergency contact name" value={settings.emergencyContact.name} onChangeText={(v) => update({ emergencyContact: { ...settings.emergencyContact, name: v } })} />
        <Field label="Emergency contact phone" value={settings.emergencyContact.phone} onChangeText={(v) => update({ emergencyContact: { ...settings.emergencyContact, phone: v } })} keyboardType="phone-pad" />
        <Stepper label="Default check-in after" value={settings.checkInMinutes} onChange={(v) => update({ checkInMinutes: v })} step={30} min={30} max={720} unit="min" />

        <Label>HUNTING</Label>
        <Stepper label="Default effective range" value={settings.defaultRangeYds} onChange={(v) => update({ defaultRangeYds: v })} step={5} min={10} max={400} unit="yds" />

        <Label>DISPLAY & PRIVACY</Label>
        {toggle('Red-light theme', redLight, () => set({ redLight: !redLight }), 'Hunt mode turns this on automatically')}
        {toggle('Haptics', settings.haptics, () => update({ haptics: !settings.haptics }), 'Off by default. The app never plays sounds.')}
        {toggle('Allow sharing plans', settings.shareOptIn, () => update({ shareOptIn: !settings.shareOptIn }), 'Off by default. Nothing leaves your phone unless this is on AND you tap Share.')}

        <Label>OFFLINE MAPS</Label>
        <Body dim>Download USGS imagery and topo for the active property (zoom 12–16, public domain) so the basemap works with no signal.</Body>
        <BigButton label="Download offline basemap" kind="secondary" disabled={!property?.calibration?.originGeo} onPress={() => void downloadMaps()} sublabel={property?.calibration?.originGeo ? property.name : 'Geo-reference the map first'} />
        {pack ? <Text style={{ color: t.textDim }}>{pack}</Text> : null}

        <Label>DATA</Label>
        <Body dim>All data is stored on this phone in an encrypted database. The key lives in the secure enclave/keystore.</Body>
        <BigButton
          label="Delete all data"
          kind="danger"
          onPress={() =>
            Alert.alert('Delete everything?', 'Properties, plans, hunts and sightings will be permanently erased from this phone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  await wipeAllData();
                  set({ properties: [], activePropertyId: null, plan: null, hunt: null });
                  router.replace('/');
                },
              },
            ])
          }
        />
        <View style={{ marginTop: SPACE, padding: 12, borderRadius: RADIUS, borderWidth: 1, borderColor: t.border }}>
          <Disclaimer text={DISCLAIMER} />
        </View>
      </ScrollView>
    </Screen>
  );
}

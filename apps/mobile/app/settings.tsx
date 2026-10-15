import React, { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { DISCLAIMER, type WeaponType } from '@msp/engine';
import { DEFAULT_RANGE_YDS, LEGAL_MINUTES_MAX, LEGAL_MINUTES_MIN, MAX_RANGE_YDS, useAppStore, type Settings } from '../src/state/store';
import { useTheme } from '../src/theme/ThemeContext';
import { BigButton, Body, Disclaimer, Field, Label, Screen, Segmented, Stepper } from '../src/components/ui';
import { setSetting } from '../src/db/repos';
import { deleteAllData } from '../src/services/dataReset';
import { checkInBlockedReason, ensureNotificationPermission } from '../src/services/checkin';
import { androidApiLevel, isAndroid, openAppSettings } from '../src/services/platform';
import { downloadOfflinePack } from '../src/services/offlineMaps';
import { font, RADIUS, SPACE, TOUCH } from '../src/theme/theme';

const WEAPONS: readonly WeaponType[] = ['bow', 'crossbow', 'muzzleloader', 'shotgun', 'rifle'];
const WEAPON_LABELS: Partial<Record<WeaponType, string>> = { bow: 'Bow', crossbow: 'Xbow', muzzleloader: 'Muzz', shotgun: 'Shotgun', rifle: 'Rifle' };

export default function SettingsScreen() {
  const t = useTheme();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const redLight = useAppStore((s) => s.redLight);
  const set = useAppStore((s) => s.set);
  const property = useAppStore((s) => s.activeProperty());
  const [pack, setPack] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Set synchronously, so a double tap in the same frame can't start a second download.
  const downloadingRef = useRef(false);
  const [notif, setNotif] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);

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

  const checkReminders = async () => {
    const granted = await ensureNotificationPermission().catch(() => false);
    const blocked = granted ? await checkInBlockedReason().catch(() => undefined) : undefined;
    setNotif(granted && !blocked ? 'Check-in reminders can fire ✓' : (blocked ?? 'Notifications are off. Open Settings to allow them.'));
  };

  const deleteEverything = async () => {
    setWiping(true);
    try {
      const failed = await deleteAllData();
      if (failed.length) Alert.alert('Some data could not be deleted', `Could not remove: ${failed.join(', ')}. Try again, or uninstall the app to remove everything.`);
      router.replace('/');
    } finally {
      setWiping(false);
    }
  };

  const rangeMismatch = settings.defaultRangeYds > MAX_RANGE_YDS[settings.defaultWeapon];

  const downloadMaps = async () => {
    if (!property || downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    try {
      setPack('Starting…');
      await downloadOfflinePack(property, 'imageryTopo', (pct) => setPack(`Downloading USGS imagery/topo… ${pct}%`));
      setPack('Offline basemap ready ✓');
    } catch (e) {
      setPack(e instanceof Error ? e.message : 'Download failed');
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
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
        <BigButton label="Check reminder permission" kind="secondary" onPress={() => void checkReminders()} sublabel="Check-in reminders need notifications on" />
        {notif ? <Text style={{ color: t.textDim }}>{notif}</Text> : null}
        {isAndroid && androidApiLevel >= 31 ? (
          <>
            <Body dim>Android can hold back reminders by up to an hour unless "Alarms & reminders" is allowed for Stand Planner (App info › Alarms & reminders).</Body>
            <BigButton label="Open app settings" kind="ghost" onPress={() => void openAppSettings()} />
          </>
        ) : null}

        <Label>HUNTING</Label>
        <Segmented options={WEAPONS} value={settings.defaultWeapon} onChange={(w) => update({ defaultWeapon: w, defaultRangeYds: DEFAULT_RANGE_YDS[w] })} labels={WEAPON_LABELS} />
        <Stepper
          label={`Default effective range (${WEAPON_LABELS[settings.defaultWeapon] ?? settings.defaultWeapon})`}
          value={settings.defaultRangeYds}
          onChange={(v) => update({ defaultRangeYds: v })}
          step={5}
          min={10}
          max={MAX_RANGE_YDS[settings.defaultWeapon]}
          unit="yds"
        />
        {rangeMismatch ? (
          <Text style={{ color: t.status.caution, fontSize: font.sm }}>
            ! {settings.defaultRangeYds} yds is beyond {WEAPON_LABELS[settings.defaultWeapon] ?? settings.defaultWeapon} range, so plans start at {DEFAULT_RANGE_YDS[settings.defaultWeapon]} yds. Pick your weapon above.
          </Text>
        ) : null}

        <Label>LEGAL HOURS</Label>
        <Body dim>Check your state's rules; many Midwest states use 30/30. Plans and Hunt mode use these to show legal shooting light.</Body>
        <Stepper label="Legal hours: minutes before sunrise" value={settings.legalMinutesBefore} onChange={(v) => update({ legalMinutesBefore: v })} step={5} min={LEGAL_MINUTES_MIN} max={LEGAL_MINUTES_MAX} unit="min" />
        <Stepper label="Legal hours: minutes after sunset" value={settings.legalMinutesAfter} onChange={(v) => update({ legalMinutesAfter: v })} step={5} min={LEGAL_MINUTES_MIN} max={LEGAL_MINUTES_MAX} unit="min" />

        <Label>DISPLAY & PRIVACY</Label>
        {toggle('Red-light theme', redLight, () => set({ redLight: !redLight }), 'Hunt mode turns this on automatically')}
        {toggle('Haptics', settings.haptics, () => update({ haptics: !settings.haptics }), 'Off by default. The app plays no sounds; on iPhone, check-in reminders use the system alert (ring switch on silent = vibrate only).')}
        {toggle('Allow sharing plans', settings.shareOptIn, () => update({ shareOptIn: !settings.shareOptIn }), 'Off by default. Your plans, hunts and sightings never leave your phone unless this is on AND you tap Share.')}
        <Body dim>
          Lookups use your property's coordinates: the forecast comes from the National Weather Service, and terrain and land cover from USGS, MRLC and USDA cropland data (hosted by George Mason University). Those public services see the coordinates they're asked about, not your plans. In Vision proxy mode the map photo goes to your proxy, which sends it to Claude.
        </Body>

        <Label>OFFLINE MAPS</Label>
        <Body dim>Download USGS imagery and topo for the active property (zoom 12–16, public domain) so the basemap works with no signal.</Body>
        <BigButton
          label={downloading ? 'Downloading…' : 'Download offline basemap'}
          kind="secondary"
          loading={downloading}
          disabled={!property?.calibration?.originGeo || downloading}
          onPress={() => void downloadMaps()}
          sublabel={property?.calibration?.originGeo ? property.name : 'Geo-reference the map first'}
        />
        {pack ? <Text style={{ color: t.textDim }}>{pack}</Text> : null}

        <Label>DATA</Label>
        <Body dim>
          Properties, plans, hunts, sightings and settings are stored on this phone in an encrypted database; its key stays in this phone's Keychain/Keystore and never moves to another phone. Map photos are stored inside that same encrypted database. A working copy of each photo is kept in the app's private cache (not backed up) and rebuilt from the database whenever it is missing; Delete all data removes both, and the temporary copies your photo picker made.
        </Body>
        <BigButton
          label="Delete all data"
          kind="danger"
          loading={wiping}
          onPress={() =>
            Alert.alert(
              'Delete everything?',
              'Properties, plans, hunts, sightings, map photos, offline maps, settings (including your emergency contact) and any pending check-in reminders will be permanently erased from this phone.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => void deleteEverything() },
              ],
            )
          }
        />
        <View style={{ marginTop: SPACE, padding: 12, borderRadius: RADIUS, borderWidth: 1, borderColor: t.border }}>
          <Disclaimer text={DISCLAIMER} />
        </View>
      </ScrollView>
    </Screen>
  );
}

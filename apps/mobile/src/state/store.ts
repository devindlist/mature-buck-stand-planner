import { create } from 'zustand';
import type { HuntWindow, ISODate, LatLon, Plan, PlanCard, Property, SeasonPhase, Vec, WeaponType, WeatherSnapshot } from '@msp/engine';
import { nextSit } from '../utils/format';

export interface Settings {
  visionMode: 'mock' | 'proxy';
  proxyUrl: string;
  appToken: string;
  emergencyContact: { name: string; phone: string };
  /** Silent by default: no sounds anywhere; haptics opt-in. */
  haptics: boolean;
  /** Opt-in: nothing leaves the phone unless this is on AND the hunter taps Share. */
  shareOptIn: boolean;
  defaultWeapon: WeaponType;
  defaultRangeYds: number;
  checkInMinutes: number;
  /** Shooting is legal this many minutes before sunrise / after sunset (many Midwest states: 30/30; check your state's rules). */
  legalMinutesBefore: number;
  legalMinutesAfter: number;
}

/** Range of the legal-hours offsets the hunter can set in Settings (minutes). */
export const LEGAL_MINUTES_MIN = 0;
export const LEGAL_MINUTES_MAX = 60;
export const LEGAL_MINUTES_DEFAULT = 30;

/** A sensible starting range for each weapon. A saved default range is always paired with its weapon. */
export const DEFAULT_RANGE_YDS: Record<WeaponType, number> = { bow: 30, crossbow: 40, muzzleloader: 125, shotgun: 100, rifle: 250, handgun: 100 };
/** Longest range that is plausible for each weapon. A saved range beyond it was not meant for that weapon. */
export const MAX_RANGE_YDS: Record<WeaponType, number> = { bow: 80, crossbow: 100, muzzleloader: 250, shotgun: 200, rifle: 400, handgun: 200 };

/** The default range for a weapon, never a range that only makes sense for a different weapon. */
export function defaultRangeFor(weapon: WeaponType, savedYds: number): number {
  return savedYds > 0 && savedYds <= MAX_RANGE_YDS[weapon] ? savedYds : DEFAULT_RANGE_YDS[weapon];
}

export const DEFAULT_SETTINGS: Settings = {
  visionMode: 'mock',
  proxyUrl: '',
  appToken: '',
  emergencyContact: { name: '', phone: '' },
  haptics: false,
  shareOptIn: false,
  defaultWeapon: 'bow',
  defaultRangeYds: 30,
  checkInMinutes: 240,
  legalMinutesBefore: LEGAL_MINUTES_DEFAULT,
  legalMinutesAfter: LEGAL_MINUTES_DEFAULT,
};

const legalMinutes = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(LEGAL_MINUTES_MAX, Math.max(LEGAL_MINUTES_MIN, Math.round(v))) : LEGAL_MINUTES_DEFAULT);

/**
 * Settings read back from storage: missing fields (an older version) get their defaults,
 * and the legal-hours offsets are kept inside what Settings lets the hunter pick.
 */
export function normalizeSettings(saved: unknown): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? (saved as Partial<Settings>) : {}) };
  return { ...merged, legalMinutesBefore: legalMinutes(merged.legalMinutesBefore), legalMinutesAfter: legalMinutes(merged.legalMinutesAfter) };
}

export interface PlanDraft {
  date: ISODate;
  window: HuntWindow;
  weaponType: WeaponType;
  rangeYds: number;
  phaseOverride?: SeasonPhase;
  setbackOverrideM?: number;
  /** Hunter overrides win over the forecast and are badged in the UI. */
  overrides: Partial<Pick<WeatherSnapshot, 'windFromDeg' | 'windSpeedMph' | 'windGustMph' | 'tempF' | 'cloudCoverPct' | 'precipType' | 'pressureTrend'>>;
}

/**
 * The hunt in progress. Persisted (settings key 'activeHunt') on every change, so a sit
 * survives the OS killing the app, and the scheduled check-in alarms can always be cancelled.
 */
export interface HuntSession {
  huntId: string;
  planId: string;
  propertyId: string;
  standId: string;
  startedAt: string;
  checkInDueAt?: string;
  checkInNotificationIds?: string[];
  /** Kept on the session so Hunt mode, alarms and the SOS text work even if the plan is gone. */
  standName?: string;
  standPosition?: Vec;
  /** The stand's coordinates (geo-referenced maps only): the SOS fallback when GPS has no fix. */
  standGeo?: LatLon;
  /** undefined while arming; false means NO reminder will fire (Hunt mode says so loudly). */
  checkInArmed?: boolean;
  /** Why the check-in is not armed, in plain words. */
  checkInProblem?: string;
  /** Wind the hunter felt at the tree (FROM, degrees). Observed data outranks the forecast. */
  observedWindFromDeg?: number;
  observedWindAt?: string;
  /** Set only on `endedHunt`. */
  endedAt?: string;
}

interface AppState {
  ready: boolean;
  redLight: boolean;
  settings: Settings;
  properties: Property[];
  activePropertyId: string | null;
  draft: PlanDraft;
  weather: WeatherSnapshot | null;
  weatherStatus: 'idle' | 'loading' | 'ok' | 'offline' | 'error';
  weatherError?: string;
  plan: { plan: Plan; card: PlanCard } | null;
  selectedStandId: string | null;
  hunt: HuntSession | null;
  /** The last hunt that was ended but maybe not logged yet. Its alarms are already cancelled. */
  endedHunt: HuntSession | null;

  set: (patch: Partial<AppState>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setDraft: (patch: Partial<PlanDraft>) => void;
  setOverride: (patch: PlanDraft['overrides']) => void;
  clearOverrides: () => void;
  upsertProperty: (p: Property) => void;
  activeProperty: () => Property | null;
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  redLight: false,
  settings: DEFAULT_SETTINGS,
  properties: [],
  activePropertyId: null,
  draft: { ...nextSit(), weaponType: 'bow', rangeYds: 30, overrides: {} },
  weather: null,
  weatherStatus: 'idle',
  plan: null,
  selectedStandId: null,
  hunt: null,
  endedHunt: null,

  set: (patch) => set(patch),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  setOverride: (patch) => set((s) => ({ draft: { ...s.draft, overrides: { ...s.draft.overrides, ...patch } } })),
  clearOverrides: () => set((s) => ({ draft: { ...s.draft, overrides: {} } })),
  upsertProperty: (p) =>
    set((s) => ({
      properties: [p, ...s.properties.filter((x) => x.id !== p.id)],
      activePropertyId: s.activePropertyId ?? p.id,
    })),
  activeProperty: () => {
    const s = get();
    return s.properties.find((p) => p.id === s.activePropertyId) ?? s.properties[0] ?? null;
  },
}));

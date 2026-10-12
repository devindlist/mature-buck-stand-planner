import { create } from 'zustand';
import type { HuntWindow, ISODate, Plan, PlanCard, Property, SeasonPhase, WeaponType, WeatherSnapshot } from '@msp/engine';
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
};

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

export interface HuntSession {
  huntId: string;
  planId: string;
  propertyId: string;
  standId: string;
  startedAt: string;
  checkInDueAt?: string;
  checkInNotificationIds?: string[];
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

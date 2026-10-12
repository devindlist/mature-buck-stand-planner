/**
 * Moon phase from the mean synodic month. Good to within about half a day, which is
 * more precision than a moon-phase hunting modifier deserves (it is tagged
 * low-confidence everywhere it is shown).
 */
const SYNODIC_MONTH = 29.530588853;
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC

export type MoonPhaseName =
  | 'new'
  | 'waxing_crescent'
  | 'first_quarter'
  | 'waxing_gibbous'
  | 'full'
  | 'waning_gibbous'
  | 'last_quarter'
  | 'waning_crescent';

export interface MoonInfo {
  ageDays: number;
  /** 0 = new, 0.5 = full. */
  phaseFraction: number;
  illumination: number;
  name: MoonPhaseName;
  label: string;
}

const LABELS: Record<MoonPhaseName, string> = {
  new: 'New moon',
  waxing_crescent: 'Waxing crescent',
  first_quarter: 'First quarter',
  waxing_gibbous: 'Waxing gibbous',
  full: 'Full moon',
  waning_gibbous: 'Waning gibbous',
  last_quarter: 'Last quarter',
  waning_crescent: 'Waning crescent',
};

export function moonInfo(at: Date): MoonInfo {
  const days = (at.getTime() - KNOWN_NEW_MOON_MS) / 86_400_000;
  const age = ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const phaseFraction = age / SYNODIC_MONTH;
  const illumination = (1 - Math.cos(2 * Math.PI * phaseFraction)) / 2;
  const idx = Math.floor(((phaseFraction * 8 + 0.5) % 8 + 8) % 8);
  const names: MoonPhaseName[] = ['new', 'waxing_crescent', 'first_quarter', 'waxing_gibbous', 'full', 'waning_gibbous', 'last_quarter', 'waning_crescent'];
  const name = names[idx];
  return { ageDays: age, phaseFraction, illumination, name, label: LABELS[name] };
}

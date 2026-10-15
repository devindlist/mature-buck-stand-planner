import type { ISODate, LegalHours, SunTimes } from '../models.ts';
import { DEG } from '../geo/geometry.ts';

/**
 * Sunrise / sunset using the NOAA Solar Calculator algorithm
 * (Meeus, "Astronomical Algorithms"), accurate to about a minute in the lower 48.
 * Runs fully offline.
 */

function julianDay(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

const julianCentury = (jd: number): number => (jd - 2451545.0) / 36525.0;

function geomMeanLongSun(t: number): number {
  const l = 280.46646 + t * (36000.76983 + 0.0003032 * t);
  return ((l % 360) + 360) % 360;
}

const geomMeanAnomalySun = (t: number): number => 357.52911 + t * (35999.05029 - 0.0001537 * t);
const eccentricityEarthOrbit = (t: number): number => 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

function sunEqOfCenter(t: number): number {
  const m = geomMeanAnomalySun(t) * DEG;
  return Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
}

function sunApparentLong(t: number): number {
  const trueLong = geomMeanLongSun(t) + sunEqOfCenter(t);
  const omega = 125.04 - 1934.136 * t;
  return trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
}

function obliquityCorrection(t: number): number {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const e0 = 23 + (26 + seconds / 60) / 60;
  const omega = 125.04 - 1934.136 * t;
  return e0 + 0.00256 * Math.cos(omega * DEG);
}

function sunDeclination(t: number): number {
  const e = obliquityCorrection(t) * DEG;
  const lambda = sunApparentLong(t) * DEG;
  return Math.asin(Math.sin(e) * Math.sin(lambda)) / DEG;
}

/** Equation of time, minutes. */
function equationOfTime(t: number): number {
  const epsilon = obliquityCorrection(t) * DEG;
  const l0 = geomMeanLongSun(t) * DEG;
  const e = eccentricityEarthOrbit(t);
  const m = geomMeanAnomalySun(t) * DEG;
  let y = Math.tan(epsilon / 2);
  y *= y;
  const eq =
    y * Math.sin(2 * l0) -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * e * e * Math.sin(2 * m);
  return (4 * eq) / DEG;
}

/** Hour angle (degrees) at sunrise for the standard 90.833° zenith. NaN in polar day/night. */
function hourAngleSunrise(latDeg: number, declDeg: number): number {
  const lat = latDeg * DEG;
  const dec = declDeg * DEG;
  const cosH = Math.cos(90.833 * DEG) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec);
  return Math.acos(cosH) / DEG;
}

/** Minutes after 00:00 UTC on the given Julian day. Longitude is east-positive. */
function eventUtcMinutes(rising: boolean, jd: number, lat: number, lon: number): number {
  const compute = (tCent: number) => {
    const eqTime = equationOfTime(tCent);
    const decl = sunDeclination(tCent);
    let ha = hourAngleSunrise(lat, decl);
    if (!rising) ha = -ha;
    const delta = -lon - ha;
    return 720 + 4 * delta - eqTime;
  };
  const first = compute(julianCentury(jd));
  return compute(julianCentury(jd + first / 1440));
}

function solarNoonUtcMinutes(jd: number, lon: number): number {
  const first = 720 - 4 * lon - equationOfTime(julianCentury(jd));
  return 720 - 4 * lon - equationOfTime(julianCentury(jd + first / 1440));
}

function parseDate(date: ISODate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date ${date}`);
  return { y, m, d };
}

const toIso = (y: number, m: number, d: number, minutes: number): string => new Date(Date.UTC(y, m - 1, d) + Math.round(minutes * 60_000)).toISOString();

/**
 * Sunrise, sunset and solar noon for a local calendar date.
 * `date` is the hunter's local date; for US longitudes, the local day's events all fall
 * between ~10:00 and ~04:00(+1) UTC, which the UTC-minute math handles naturally.
 */
export function sunTimes(date: ISODate, lat: number, lon: number): SunTimes {
  const { y, m, d } = parseDate(date);
  const jd = julianDay(y, m, d);
  const rise = eventUtcMinutes(true, jd, lat, lon);
  const set = eventUtcMinutes(false, jd, lat, lon);
  if (Number.isNaN(rise) || Number.isNaN(set)) throw new Error('No sunrise/sunset at this latitude on this date.');
  return {
    sunrise: toIso(y, m, d, rise),
    sunset: toIso(y, m, d, set),
    solarNoon: toIso(y, m, d, solarNoonUtcMinutes(jd, lon)),
  };
}

/** Legal shooting hours default to 30 min before sunrise and 30 min after sunset (many Midwest states). */
export const DEFAULT_LEGAL_MINUTES = 30;
/** The hunter can set 0..60 minutes; anything else is clamped (a typo must not move legal light by hours). */
export const MAX_LEGAL_MINUTES = 60;

/** A usable legal-light offset: default for a missing or non-numeric value, otherwise clamped to 0..60. */
export function legalMinutes(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_LEGAL_MINUTES, Math.max(0, Math.round(v))) : DEFAULT_LEGAL_MINUTES;
}

/**
 * Legal shooting hours. Most Midwest states use 30 minutes before sunrise to
 * 30 minutes after sunset for deer, but rules vary by state, weapon and season, so the
 * offsets are the hunter's own setting (PlanInputs.legalMinutesBefore / legalMinutesAfter).
 * `fromSetting` words the rule as the hunter's choice instead of the typical default.
 * The UI always pairs this with a "verify your state regulations" reminder.
 */
export function legalHours(sun: SunTimes, minutesBefore: number = DEFAULT_LEGAL_MINUTES, minutesAfter: number = DEFAULT_LEGAL_MINUTES, fromSetting = false): LegalHours {
  const before = legalMinutes(minutesBefore);
  const after = legalMinutes(minutesAfter);
  return {
    start: new Date(Date.parse(sun.sunrise) - before * 60_000).toISOString(),
    end: new Date(Date.parse(sun.sunset) + after * 60_000).toISOString(),
    rule: fromSetting ? `${before} min before sunrise to ${after} min after sunset: your setting` : `${before} min before sunrise to ${after} min after sunset (typical, so verify your state's rules)`,
  };
}

/** Legal hours for a plan: the hunter's setting when the inputs carry one, else the typical 30/30. */
export function legalHoursFor(sun: SunTimes, inputs: { legalMinutesBefore?: number; legalMinutesAfter?: number }): LegalHours {
  const set = inputs.legalMinutesBefore !== undefined || inputs.legalMinutesAfter !== undefined;
  return legalHours(sun, inputs.legalMinutesBefore, inputs.legalMinutesAfter, set);
}

export const addMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

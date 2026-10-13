import type { Decision, HourlyWind, MapFeature, Vec, WeaponType, WeatherSnapshot, ShotLane } from '../models.ts';
import { pointGeometryDistance, sectorPolygon, shapeDistance, ydsToM } from '../geo/geometry.ts';

export const DISCLAIMER =
  'Planning aid only. Wind, thermals and deer behavior are probabilistic, and map detections can be wrong. ' +
  'You are responsible for safe, legal and ethical hunting decisions. Always verify your state regulations.';

export const HARNESS_REMINDER = 'Wear a full-body harness and stay connected from the moment you leave the ground until you are back down. Use a lifeline.';

export function weaponSafetyReminders(weapon: WeaponType): string[] {
  const base = ['Raise and lower your weapon with a haul line. Never climb with it, and unload firearms first.'];
  if (weapon === 'bow' || weapon === 'crossbow') base.push('Use broadheads only inside your practiced range. Pass on alert or quartering-to deer.');
  else base.push('Know your target and what is beyond it. Wear blaze orange where required.');
  return base;
}

export function planReminders(stateCode: string, weapon: WeaponType): string[] {
  const st = stateCode.toUpperCase();
  const r = [
    `Regulations: confirm ${st} season dates, legal shooting hours, weapon rules, tagging and harvest reporting before you go.`,
    `CWD: check whether this county is in a ${st} CWD management zone. Follow carcass-transport and testing rules, and don't move high-risk parts (brain, spine) out of the zone.`,
    'Set the check-in timer with an emergency contact before every sit.',
  ];
  if (weapon !== 'bow' && weapon !== 'crossbow') r.push('Firearm seasons: blaze orange requirements apply in most Midwest states.');
  return r;
}

/**
 * Hard weather gates. Tree-stand safety beats any score.
 *
 * The gates look at the WORST hour of the sit, not just the snapshot hour: a 40 mph
 * gust at 3 PM is no safer because the 4 PM midpoint is calm. `hourly` is the forecast
 * through the sit window; it defaults to the snapshot's own hourly list, so the one-
 * argument call keeps working. Values the hunter typed in win over the forecast.
 */
export function assessWeather(w: WeatherSnapshot, hourly: HourlyWind[] | undefined = w.hourly): Decision {
  const noGo: string[] = [];
  const caution: string[] = [];
  const hours = hourly ?? [];
  const byHand = (field: string) => w.overriddenFields.includes(field);
  let gust = w.windGustMph;
  let gustFromForecast = false;
  if (!byHand('windGustMph')) {
    for (const h of hours) {
      const g = Math.max(h.windGustMph ?? 0, h.windSpeedMph);
      if (g > gust) {
        gust = g;
        gustFromForecast = true;
      }
    }
  }
  let chill = w.windChillF ?? windChillF(w.tempF, w.windSpeedMph);
  let chillFromForecast = false;
  let maxTemp = w.tempF;
  if (!byHand('tempF')) {
    for (const h of hours) {
      if (h.tempF === undefined) continue;
      const c = windChillF(h.tempF, h.windSpeedMph);
      if (c < chill) {
        chill = c;
        chillFromForecast = true;
      }
      maxTemp = Math.max(maxTemp, h.tempF);
    }
  }
  const during = (fromForecast: boolean) => (fromForecast ? ' during the sit' : '');
  if (w.precipType === 'thunderstorm') noGo.push('Thunderstorms forecast. Never be in a tree stand with lightning around.');
  if (w.precipType === 'freezing_rain') noGo.push('Freezing rain. Ladders, steps and platforms ice over.');
  if (w.precipType === 'sleet') caution.push('Sleet. Steps and platforms get slick, so clear them and climb slowly.');
  if (gust >= 35) noGo.push(`Gusts to ${Math.round(gust)} mph${during(gustFromForecast)}. Tree stands and dead limbs are dangerous.`);
  else if (gust >= 25) caution.push(`Gusts to ${Math.round(gust)} mph${during(gustFromForecast)}. Pick a healthy, sheltered tree or a ground blind.`);
  if (chill <= -15) noGo.push(`Wind chill ${Math.round(chill)}°F${during(chillFromForecast)}. Frostbite can set in within 30 minutes.`);
  else if (chill <= 5) caution.push(`Wind chill ${Math.round(chill)}°F${during(chillFromForecast)}. Dress for hypothermia risk and shorten the sit.`);
  if (maxTemp >= 85) caution.push(`${Math.round(maxTemp)}°F. Heat risk, and meat spoils fast, so plan quick recovery.`);
  // Defaults are never an all-clear: nobody checked the sky for gusts, lightning or cold.
  if (w.placeholder) {
    caution.push(
      w.overriddenFields.length
        ? 'No forecast loaded. Only what you entered is real, so check gusts, lightning and temperature yourself before you climb.'
        : 'No forecast loaded. These are default conditions, so check wind, gusts, lightning and temperature yourself before you climb.',
    );
  }
  if (noGo.length) return { status: 'no_go', reasons: [...noGo, ...caution] };
  if (caution.length) return { status: 'caution', reasons: caution };
  return { status: 'go', reasons: ['No weather hazards in the forecast.'] };
}

/** NWS wind chill formula (valid for T <= 50°F and wind >= 3 mph). */
export function windChillF(tempF: number, windMph: number): number {
  if (tempF > 50 || windMph < 3) return tempF;
  const v = windMph ** 0.16;
  return 35.74 + 0.6215 * tempF - 35.75 * v + 0.4275 * tempF * v;
}

/**
 * Distance (yards) a projectile can still be dangerous in a typical elevated-stand
 * setup. Used only to flag no-shot lanes toward roads and houses; deliberately
 * conservative for archery and practical (not maximum ballistic) for firearms.
 */
export const DANGER_DISTANCE_YDS: Record<WeaponType, number> = {
  bow: 150,
  crossbow: 200,
  shotgun: 800,
  muzzleloader: 1000,
  handgun: 1000,
  rifle: 1000,
};

/** Eight 45° shot sectors around a stand. Any sector reaching a road or house is no-shot. */
export function shotLanes(stand: Vec, features: MapFeature[], weapon: WeaponType, effectiveRangeYds: number): ShotLane[] {
  const hazards = features.filter((f) => f.status === 'active' && (f.type === 'road' || f.type === 'house'));
  const dangerM = ydsToM(DANGER_DISTANCE_YDS[weapon]);
  const lanes: ShotLane[] = [];
  for (let i = 0; i < 8; i++) {
    const center = i * 45;
    const sector = sectorPolygon(stand, center, 22.5, dangerM, 6);
    const hit = hazards.find((h) => pointGeometryDistance(stand, h.geometry) <= dangerM && shapeDistance(sector, true, h.geometry.points, h.geometry.kind === 'polygon') === 0);
    lanes.push({
      fromDeg: (center - 22.5 + 360) % 360,
      toDeg: (center + 22.5) % 360,
      status: hit ? 'no_shot' : 'open',
      maxYds: effectiveRangeYds,
      reason: hit
        ? `${hit.type === 'road' ? 'Road' : 'House'} within ${DANGER_DISTANCE_YDS[weapon]} yds this direction. No shots this way.`
        : `Open to ${effectiveRangeYds} yds. Confirm your backstop.`,
    });
  }
  return lanes;
}

export function laneFor(lanes: ShotLane[], bearingDeg: number): ShotLane {
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return lanes[idx];
}

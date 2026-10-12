import type { Plan, StandRecommendation } from './models.ts';
import { compass16, downwindBearing, mToYds } from './geo/geometry.ts';

/**
 * Offline plan card: a compact, render-ready summary of a plan that the app stores
 * with the plan and shows in Hunt mode with no network. `planCardText` produces a
 * plain-text version for opt-in sharing (text message to a hunting partner, etc.).
 */
export type TimeFormatter = (iso: string) => string;

export interface PlanCardStand {
  rank: number;
  isBackup: boolean;
  name: string;
  score: number;
  status: 'go' | 'caution' | 'no_go';
  reason: string;
  sitWindow: string;
  goodWinds: string;
  badWinds: string;
  entry: string;
  exit: string;
  shot: string;
  risks: string[];
  confidence: string;
  backupNote?: string;
  /** The hunter's own stand shown outside the top 3. */
  yours?: boolean;
}

export interface PlanCard {
  title: string;
  dateLine: string;
  phase: string;
  legalHours: string;
  sunLine: string;
  windLine: string;
  weatherLine: string;
  weatherStatus: 'go' | 'caution' | 'no_go';
  stands: PlanCardStand[];
  warnings: string[];
  lowConfidence: string[];
  reminders: string[];
  harness: string;
  disclaimer: string;
}

const defaultFmt: TimeFormatter = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function windList(rec: StandRecommendation, status: 'good' | 'bad'): string {
  const list = rec.windDial.sectors.filter((s) => s.status === status).map((s) => compass16(s.fromDeg));
  return list.length ? list.join(', ') : 'none';
}

function routeLine(r: StandRecommendation['entryRoute']): string {
  if (!r) return 'No access point mapped';
  const flag = r.worstStatus === 'avoid' ? ' ⚠ crosses a red zone' : r.worstStatus === 'caution' ? ' • caution sections' : ' • clean';
  return `From ${r.startLabel}, ${Math.round(mToYds(r.lengthM))} yds${flag}`;
}

function standCard(rec: StandRecommendation, fmt: TimeFormatter): PlanCardStand {
  const shot = rec.shotPlan;
  const noShot = shot.lanes.filter((l) => l.status === 'no_shot').map((l) => compass16((l.fromDeg + 22.5) % 360));
  return {
    rank: rec.rank,
    isBackup: rec.isBackup,
    name: rec.stand.name,
    score: rec.score.total,
    status: rec.decision.status,
    reason: rec.reason,
    sitWindow: `${fmt(rec.sitWindow.start)}–${fmt(rec.sitWindow.end)}`,
    goodWinds: windList(rec, 'good'),
    badWinds: windList(rec, 'bad'),
    entry: routeLine(rec.entryRoute),
    exit: routeLine(rec.exitRoute),
    shot:
      (shot.expectedShotYds !== null ? `Expect ~${shot.expectedShotYds} yds ${compass16(shot.primaryBearingDeg ?? 0)}` : 'No travel in range') +
      `; max ${shot.effectiveRangeYds} yds` +
      (noShot.length ? `; NO SHOT toward ${noShot.join(', ')}` : ''),
    risks: rec.risks.map((r) => r.text),
    confidence: `${rec.confidence.level} (${Math.round(rec.confidence.value * 100)}%)`,
    backupNote: rec.backupNote,
  };
}

export function buildPlanCard(plan: Plan, propertyName: string, fmt: TimeFormatter = defaultFmt): PlanCard {
  const w = plan.inputs.weather;
  const stands = plan.recommendations.map((r) => standCard(r, fmt));
  if (plan.backup) stands.push(standCard(plan.backup, fmt));
  for (const r of plan.yourStands ?? []) stands.push({ ...standCard(r, fmt), yours: true });
  return {
    title: `${propertyName} · ${plan.inputs.window} sit`,
    dateLine: plan.inputs.date,
    phase: plan.phase.label + (plan.phase.source === 'user' ? ' (your override)' : ''),
    legalHours: `${fmt(plan.legal.start)}–${fmt(plan.legal.end)}`,
    sunLine: `Sunrise ${fmt(plan.sun.sunrise)} · Sunset ${fmt(plan.sun.sunset)}`,
    windLine: `${compass16(w.windFromDeg)} ${Math.round(w.windSpeedMph)} mph, gusts ${Math.round(w.windGustMph)}. Scent blows ${compass16(downwindBearing(w.windFromDeg))}${w.overriddenFields.length ? ' (edited by you)' : ''}`,
    weatherLine: `${Math.round(w.tempF)}°F${w.cloudCoverPct !== undefined ? ` · ${Math.round(w.cloudCoverPct)}% cloud` : ''}${w.precipType !== 'none' ? ` · ${w.precipType.replace('_', ' ')}` : ''} · pressure ${w.pressureTrend}`,
    weatherStatus: plan.weatherDecision.status,
    stands,
    warnings: plan.warnings.filter((x) => x.level !== 'info').map((x) => x.text),
    lowConfidence: plan.modifiers.map((m) => `${m.label}: ${m.detail}`),
    reminders: plan.reminders,
    harness: 'HARNESS ON. Connected from ground to ground.',
    disclaimer: plan.disclaimer,
  };
}

export function planCardText(card: PlanCard): string {
  const lines: string[] = [];
  lines.push(card.title, card.dateLine, `Phase: ${card.phase}`, `Legal: ${card.legalHours}`, card.sunLine, `Wind: ${card.windLine}`, `Weather: ${card.weatherLine} [${card.weatherStatus.toUpperCase()}]`, '');
  for (const s of card.stands) {
    lines.push(`${s.isBackup ? 'BACKUP' : s.yours ? 'YOUR STAND' : `#${s.rank}`} ${s.name}: ${s.score}/100 [${s.status.toUpperCase().replace('_', '-')}]`);
    if (s.backupNote) lines.push(`  ${s.backupNote}`);
    lines.push(`  ${s.reason}`, `  Sit ${s.sitWindow}`, `  Good winds: ${s.goodWinds} | Bad: ${s.badWinds}`, `  In: ${s.entry}`, `  Out: ${s.exit}`, `  Shot: ${s.shot}`);
    for (const r of s.risks) lines.push(`  Risk: ${r}`);
    lines.push('');
  }
  if (card.warnings.length) lines.push(...card.warnings.map((w) => `! ${w}`), '');
  lines.push(...card.lowConfidence.map((l) => `[low confidence] ${l}`));
  lines.push(card.harness, card.disclaimer);
  return lines.join('\n');
}

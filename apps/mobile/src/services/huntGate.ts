import { Alert } from 'react-native';
import type { Decision, StandRecommendation } from '@msp/engine';

/**
 * One rule for starting a hunt, shared by every screen that has a "Hunt this stand" button
 * (the Results card and the plan card), so their copy and behaviour cannot drift apart.
 *
 * The planner can call a sit NO-GO (weather, an unreachable stand, a wind that fails). The app
 * never overrides the hunter and never hides a no-go either: the button stays live, turns red,
 * and asks for an explicit "I understand, start anyway" that shows the reasons first.
 */
export interface HuntGate {
  noGo: boolean;
  /** Why, in the planner's words (weather first, then the stand's own), without repeats. */
  reasons: string[];
}

/** The gate for hunting `rec`: the plan's weather decision and the stand's own decision, whichever says no-go. */
export function huntGate(rec: Pick<StandRecommendation, 'decision'> | undefined, weatherDecision?: Decision): HuntGate {
  const nos = [weatherDecision, rec?.decision].filter((d): d is Decision => !!d && d.status === 'no_go');
  return { noGo: nos.length > 0, reasons: [...new Set(nos.flatMap((d) => d.reasons))] };
}

/** Title and body of the confirmation. */
export function huntGateAlert(gate: HuntGate, standName: string): { title: string; message: string } {
  return { title: `NO-GO at ${standName} today`, message: gate.reasons.join('\n') || 'Conditions make this sit a no-go.' };
}

/** What the start button says under its label when the sit is a no-go. */
export const NO_GO_SUBLABEL = 'NO-GO today · tap to review';

/** Starts the hunt now, or (no-go) after the hunter has read the reasons and confirmed. */
export function confirmHunt(gate: HuntGate, standName: string, go: () => void): void {
  if (!gate.noGo) {
    go();
    return;
  }
  const { title, message } = huntGateAlert(gate, standName);
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'I understand, start anyway', style: 'destructive', onPress: go },
  ]);
}

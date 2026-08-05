/**
 * Sound-plan engine v0 (engineering-spec §7). Pure, versioned, deterministic.
 * AI's only role upstream is extraction into these structured shapes.
 */
export const SOUND_PLAN_VERSION = 0;

export interface VenuePA {
  hasPA: boolean;
  mixerChannels?: number;
  micsAvailable?: number;
  monitors?: number;
  hasOperator?: boolean;
}

export interface PerformerNeeds {
  /** total inputs required (vocals + instruments + DI) */
  inputs: number;
  micsNeeded?: number;
  monitorsNeeded?: number;
  /** true for fully acoustic acts that can play unamplified in a small room */
  canPlayUnamplified?: boolean;
}

/**
 * `unknown` exists because "nobody has said" is not the same as "no".
 *
 * `hasOperator` is optional and `inputs` defaults to 0 on the forms, and the
 * plan used to read both as a definite no — so a default-configured booking
 * came back `tech_needed` with the single gap "no one to run sound", on every
 * gig, in a metro with no techs yet. The differentiator cried wolf 100% of the
 * time and then couldn't deliver. Say "we don't know yet" instead.
 */
export type SoundVerdict =
  | "covered"
  | "unknown"
  | "tech_needed"
  | "tech_and_rig_needed";

export interface SoundPlan {
  version: number;
  verdict: SoundVerdict;
  gaps: string[];
}

export function soundPlan(venue: VenuePA, needs: PerformerNeeds): SoundPlan {
  const gaps: string[] = [];

  if (needs.canPlayUnamplified) {
    return { version: SOUND_PLAN_VERSION, verdict: "covered", gaps };
  }

  if (!venue.hasPA) {
    gaps.push("venue has no PA system");
    return { version: SOUND_PLAN_VERSION, verdict: "tech_and_rig_needed", gaps };
  }

  if (venue.mixerChannels != null && venue.mixerChannels < needs.inputs)
    gaps.push(
      `mixer has ${venue.mixerChannels} channels, act needs ${needs.inputs}`,
    );
  if (
    venue.micsAvailable != null &&
    needs.micsNeeded != null &&
    venue.micsAvailable < needs.micsNeeded
  )
    gaps.push(
      `venue has ${venue.micsAvailable} mics, act needs ${needs.micsNeeded}`,
    );
  if (
    venue.monitors != null &&
    needs.monitorsNeeded != null &&
    venue.monitors < needs.monitorsNeeded
  )
    gaps.push(
      `venue has ${venue.monitors} monitors, act needs ${needs.monitorsNeeded}`,
    );
  // Only a stated `false` means "there is nobody" — undefined means unanswered.
  if (venue.hasOperator === false) gaps.push("no one to run sound");

  // Unanswered essentials outrank a clean gap list: claiming "covered" when the
  // act never said how many inputs it needs, or the room never said whether
  // anyone runs the desk, is a guess dressed as an answer.
  const unanswered: string[] = [];
  if (!(needs.inputs > 0)) unanswered.push("the act hasn't listed its input count");
  if (venue.hasOperator === undefined)
    unanswered.push("the room hasn't said whether anyone runs sound");
  if ((needs.micsNeeded ?? 0) > 0 && venue.micsAvailable === undefined)
    unanswered.push("the room hasn't listed its available microphones");
  if ((needs.monitorsNeeded ?? 0) > 0 && venue.monitors === undefined)
    unanswered.push("the room hasn't listed its available monitors");

  // A known shortage remains actionable even when some other field is
  // unanswered. Uncertainty can prevent a false "covered"; it must never erase
  // a definite need for a tech or a rig.
  const severeChannelDeficit =
    venue.hasPA &&
    venue.mixerChannels != null &&
    needs.inputs > 2 * venue.mixerChannels;
  if (gaps.length > 0)
    return {
      version: SOUND_PLAN_VERSION,
      verdict: severeChannelDeficit ? "tech_and_rig_needed" : "tech_needed",
      gaps: [...gaps, ...unanswered],
    };

  if (unanswered.length > 0)
    return { version: SOUND_PLAN_VERSION, verdict: "unknown", gaps: unanswered };

  return { version: SOUND_PLAN_VERSION, verdict: "covered", gaps };
}

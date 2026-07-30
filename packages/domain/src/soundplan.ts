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
  if ((venue.micsAvailable ?? 0) < (needs.micsNeeded ?? 0))
    gaps.push(
      `venue has ${venue.micsAvailable ?? 0} mics, act needs ${needs.micsNeeded}`,
    );
  if ((venue.monitors ?? 0) < (needs.monitorsNeeded ?? 0))
    gaps.push(
      `venue has ${venue.monitors ?? 0} monitors, act needs ${needs.monitorsNeeded}`,
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
  if (unanswered.length > 0)
    return {
      version: SOUND_PLAN_VERSION,
      verdict: "unknown",
      gaps: [...gaps, ...unanswered],
    };

  if (gaps.length === 0)
    return { version: SOUND_PLAN_VERSION, verdict: "covered", gaps };

  // PA exists but is insufficient or unstaffed → a tech can bridge with the house rig
  // unless the KNOWN channel deficit is severe (more than double), in which case bring a
  // rig. An unspecified channel count is NOT a deficit: a staffed house PA that didn't
  // fill in its channel count isn't "0 channels", and treating it so would spuriously
  // inflate the conditional tech side.
  const severeChannelDeficit =
    venue.hasPA &&
    venue.mixerChannels != null &&
    needs.inputs > 2 * venue.mixerChannels;
  return {
    version: SOUND_PLAN_VERSION,
    verdict: severeChannelDeficit ? "tech_and_rig_needed" : "tech_needed",
    gaps,
  };
}

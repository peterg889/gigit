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

export type SoundVerdict = "covered" | "tech_needed" | "tech_and_rig_needed";

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
  if (!venue.hasOperator) gaps.push("no one to run sound");

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

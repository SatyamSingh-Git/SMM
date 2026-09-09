// The autonomy dial.
//
// Full autonomy that cannot be partially disengaged is unshippable. Each stage
// of the loop carries its own level, so a stage can be promoted on its own and
// rolled back on its own — which is what makes "quality dropped last week"
// answerable rather than a shrug.
//
//   off      the stage does not run
//   suggest  produces output, parks it as a draft, notifies
//   review   produces and schedules, but holds at a gate until approved
//   auto     produces, schedules, publishes unattended
//
// This is a ROLLOUT control, not a security boundary. It exists so a human can
// decide how much of the loop runs unattended, not to defend against a hostile
// caller. When the profile has not loaded, it falls back to the built-in
// defaults, which reproduce today's behaviour exactly: publishing and replying
// already run unattended; nothing else exists yet.

import { getProfile } from "./profile/resolver.js";
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type AutonomyStage,
} from "./profile/types.js";

export const AUTONOMY_DEFAULTS: Record<AutonomyStage, AutonomyLevel> = {
  plan: "off",
  generate_media: "off",
  write_caption: "off",
  schedule: "off",
  publish: "auto",
  reply: "auto",
  learn: "auto",
};

/** Rank for comparisons. Higher means more of the loop runs without a human. */
function rank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

export function levelFor(stage: AutonomyStage): AutonomyLevel {
  const configured = getProfile()?.policy.autonomy?.[stage];
  return configured ?? AUTONOMY_DEFAULTS[stage];
}

/** Does this stage run at all? */
export function isEnabled(stage: AutonomyStage): boolean {
  return levelFor(stage) !== "off";
}

/** Does this stage act without waiting for a human? */
export function runsUnattended(stage: AutonomyStage): boolean {
  return levelFor(stage) === "auto";
}

/** Is this stage at `level` or higher? */
export function atLeast(stage: AutonomyStage, level: AutonomyLevel): boolean {
  return rank(levelFor(stage)) >= rank(level);
}

export type StageDecision =
  | { act: "skip"; level: AutonomyLevel }
  | { act: "draft"; level: AutonomyLevel }
  | { act: "gate"; level: AutonomyLevel }
  | { act: "proceed"; level: AutonomyLevel };

/**
 * What a stage should do right now. Callers switch on `act` rather than
 * re-deriving the level, so the mapping from level to behaviour lives in one
 * place and cannot drift between stages.
 */
export function decide(stage: AutonomyStage): StageDecision {
  const level = levelFor(stage);
  switch (level) {
    case "off":
      return { act: "skip", level };
    case "suggest":
      return { act: "draft", level };
    case "review":
      return { act: "gate", level };
    case "auto":
      return { act: "proceed", level };
  }
}

/** Every stage and its current level, for the status UI. */
export function autonomySnapshot(): Record<AutonomyStage, AutonomyLevel> {
  const out = {} as Record<AutonomyStage, AutonomyLevel>;
  for (const stage of Object.keys(AUTONOMY_DEFAULTS) as AutonomyStage[]) {
    out[stage] = levelFor(stage);
  }
  return out;
}

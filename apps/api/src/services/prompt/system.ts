// The bridge between the pure composer and the loaded profile. Call sites use
// this; nothing outside should reach for a prompt constant.
//
// Two accessors on purpose, matching the two failure postures:
//
//   systemPromptFor    throws  — request-driven paths where a person is
//                                waiting and a clear error beats silence
//   trySystemPromptFor null    — unattended paths (the reply worker) that must
//                                SKIP rather than guess. A skipped reply is
//                                recoverable; one published in a default voice
//                                is not.

import { getProfile, requireProfile } from "../profile/resolver.js";
import type { VoiceTask } from "../profile/types.js";
import { composeSubjectDescriptor, composeSystemPrompt } from "./compose.js";

export function systemPromptFor(task: VoiceTask): string {
  return composeSystemPrompt(requireProfile(), task);
}

export function trySystemPromptFor(task: VoiceTask): string | null {
  const p = getProfile();
  return p ? composeSystemPrompt(p, task) : null;
}

/** Subject descriptor for image prompts. Empty string if none is configured. */
export function subjectDescriptor(): string {
  return composeSubjectDescriptor(requireProfile());
}

export function trySubjectDescriptor(): string | null {
  const p = getProfile();
  return p ? composeSubjectDescriptor(p) : null;
}

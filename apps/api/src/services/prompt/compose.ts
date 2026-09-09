// Prompt composition. Pure: no I/O, no clock, no randomness — so it is fully
// unit-testable and so its output is byte-stable between profile edits.
//
// Why byte-stability matters as much as correctness: DeepSeek bills a cached
// prompt prefix at a fraction of the miss price, and that discount is the
// largest recurring cost lever in this system. The composer produces the
// STABLE half of every request. Volatile data — the comment being replied to,
// today's date, the specific post — is appended by the caller as user
// messages, never mixed into what this returns.
//
// A profile edit legitimately busts the cache once. A code change that alters
// this output silently multiplies the bill, which is what the hash test in
// compose.test.ts is there to catch.

import type { Identity, Profile, VoiceTask } from "../profile/types.js";

/** Substitute {{placeholders}} from identity. Unknown ones are left alone. */
export function render(template: string, identity: Identity): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    switch (name) {
      case "handle":
        return identity.handle;
      case "displayName":
        return identity.displayName;
      case "pronouns":
        return identity.pronouns;
      case "ageBand":
        return identity.ageBand;
      case "nationality":
        return identity.nationality;
      case "locale":
        return identity.locale;
      case "languages":
        return identity.languages.join(", ");
      case "niche":
        return identity.niche;
      case "audience":
        return identity.audience;
      default:
        // Left verbatim rather than blanked: a visible "{{typo}}" in the
        // output is far easier to spot than a silently missing clause. Writes
        // reject unknown placeholders anyway (see unknownPlaceholders).
        return whole;
    }
  });
}

/**
 * The system prompt for one task. This is the whole stable prefix — callers
 * pass it as the `system` message and put everything volatile in `user`.
 */
export function composeSystemPrompt(profile: Profile, task: VoiceTask): string {
  return render(profile.voice[task], profile.identity);
}

/**
 * The subject descriptor injected at the head of every image prompt in a set.
 * Empty string when the profile has no descriptor — callers decide whether
 * that is acceptable for their task.
 */
export function composeSubjectDescriptor(profile: Profile): string {
  return render(profile.visual.subjectDescriptor, profile.identity);
}

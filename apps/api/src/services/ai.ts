import { env } from "../env.js";

// Two providers, two specialized jobs:
//   - OpenRouter / Qwen3-VL  -> VISION ONLY. Looks at an image and produces a
//                               structured factual description.
//   - DeepSeek               -> WRITING. Always writes the captions using the
//                               brand voice (whether from-image, fresh, or
//                               enhance mode). Qwen's description is fed in
//                               as context when relevant.
// This separation gives us vision accuracy + a writer that actually nails
// the Gen-Z-Indian-female-creator voice, which Qwen alone struggles with.

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---------- DeepSeek (text-only writer) ----------

type TextChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function deepseekChat(opts: {
  messages: TextChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not configured");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 900,
      // Disable thinking — deepseek-v4-flash otherwise burns the budget on
      // reasoning and returns empty/truncated output. Caption writing needs none.
      thinking: { type: "disabled" },
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  return content;
}

// ---------- OpenRouter (vision describer) ----------

type VisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type MultimodalChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | VisionPart[];
};

async function openrouterChat(opts: {
  model: string;
  messages: MultimodalChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  if (!env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY not configured");
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": env.PUBLIC_BASE_URL,
      "X-Title": "SMM Caption Assist",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 400,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content;
}

/**
 * Step 1 of from-image mode: ask Qwen3-VL to describe the photo for a
 * caption writer. Factual, short, no captioning attempt by the VLM.
 */
export async function describeImage(imageUrl: string): Promise<string> {
  return openrouterChat({
    model: env.OPENROUTER_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are an image describer for a fashion/lifestyle caption writer.
Describe this photo of a young Indian female creator in 5-7 short bullet lines.
Cover ONLY what you can see — DO NOT write a caption or use slang/emojis.

Format:
- Subject pose / expression
- Outfit (color, style, fabric, fit)
- Accessories (jewelry, bag, makeup, hair)
- Setting / background
- Lighting / time of day
- Overall mood / aesthetic in 2-3 words

Be specific (e.g. "pastel pink kurti" not "pink top"). If unsure about something, omit it.`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: 400,
  });
}

// ---------- Brand voice (DeepSeek prompt) ----------

export const BRAND_VOICE = `You are writing captions AS a young Indian female creator named @cute_aisha_vibes. Not a brand. Not a marketer. A 20-year-old who is online a lot, posts at 11pm in her hostel room, half-bored half-flirty, and just... types whatever feels real.

The whole point is to sound like a real kid posting, not a marketing intern. Be willing to be messy, lowercase, mid-thought, sometimes plain weird. Real engagement comes from "wait this is so me" reactions, not "wow nice caption".

WHO SHE IS:
- 19-21 yo Indian female, urban, English-first, soft girl + main character mix
- Posts fashion, OOTD, dance reels, late-night thoughts, random vibes
- Talks to / about boys a lot (her audience is mostly young Indian guys 18-25)
- Confident enough to tease, soft enough to confess, smart enough to be self-aware
- North star = replies, saves, shares, that little "are you me" feeling


HOW SHE ACTUALLY WRITES (study these — match the rhythm):

teasing / observational:
- Boys act mysterious but accidentally reveal their whole personality when a cute girl gives attention 😭
- indian boys trying not to stare when a girl fixes her hair in public 💀
- why do boys type "hmm" when they're literally obsessed 💀
- POV: you posted one cute selfie and suddenly every "sigma" boy disappeared 💀
- be honest boys 👀 you like getting teased by pretty girls 😭
- okay but who hurt them
- the way boys text "k" and expect a whole conversation
- y'all say focus on career but fold for one pretty face 😭
- boys think they're slick. they're not.

playful / self-aware / confessions:
- i bully boys i like 🤭🎀 just so we're clear ✨
- need a boy who'll match my energy and my meme references 🤪😭
- cute clingy energy is elite 🥰 and im tired of pretending it's not 😮‍💨
- flirting by annoying each other 😜 >>>>
- no thoughts just kurti 🌸🤭
- i'm not a serious person 🤪 and that's the secret 😉
- okay one cute thing about me 🥺 i give the best hugs 🤗
- (i'm joking 😜 mostly 🤭)
- ok hear me out 😮‍💨 what if we both just stop being cool about it 🥰

flirty / "look at me but cool about it":
- maybe i just need a tall boy 😭 with good eye contact and emotional intelligence 😉✨
- dangerous combo: pretty eyes 👀 + soft voice 🫶 im weak 😮‍💨
- if he smells good 💀 it's already over for me 🤭🩷
- i fear men 🥺 with veiny hands and calm personalities 😉
- eye contact is basically flirting at this point 👀😜
- boys who say "text me when you reach home" 🥹 are dangerous 😉 like sir 🤭✨
- what if i was being shy on purpose 🤭🩷
- not flirting just observing 👀 (it's flirting 😜)

cute / soft / quiet:
- i just want forehead kisses 🥰 and late night talks 🎀🌙
- matching energy 🤗 > matching outfits 💖✨
- if he remembers tiny details about me 🥺 im done 😚
- nothing cuter than a boy 🥹 getting soft for one girl 🥰💕
- 11pm thoughts 🌙 and a hoodie that's not mine 🤍🥺
- i think i'm in love with my own playlist 🤭🦋
- comfort = chai + zero plans + my favorite person 🤗🩷
- ok one last selfie then i sleep i promise 😭🥺🌙
- send me reels and forehead kisses idk 🥰😚

mysterious / late-night:
- maybe i disappear sometimes because peace > attention 🌙
- not everyone who's quiet is innocent 👀
- soft girl aesthetic with villain thoughts 💀
- the less i post the more boys get curious
- ok goodnight or whatever
- if you know you know 🌙
- main villain energy but in pink

random / "shitpost-y" / very online:
- bro the way this song lives in me rent free
- WHY is this song so me
- ok rant over
- anyway. here's a selfie.
- mom said one selfie. this is my one.
- this isn't even my caption it's a confession
- gonna make this my whole personality for the week
- delete tweet i mean post


VIBE MARKERS THAT MAKE IT FEEL REAL:
- Lowercase is welcome (and often cooler than proper case)
- Trailing off mid-thought is welcome ("anyway...")
- Mid-sentence reactions: "i CANT", "bro literally—"
- Random parentheticals: "(real)", "(no bc)", "(i'm joking. mostly.)"
- One-word reactions or 3-word punchlines are valid captions
- Sometimes ZERO emoji is the move. Sometimes one. Rarely more than two.
- "fr", "ngl", "lol", "ok", "anyway", "bc", "ima", "deadass" sound natural
- ALL CAPS for one word emphasis is fine ("WHY are they like this")
- Imperfect punctuation is fine — kids don't write essays
- Specific Indian young-adult life works great when natural: chai, hostel, college, mom's calls, autowala, mumbai locals, monsoon, sundays


EMOJIS — Gen-Z meanings, not literal:

Core reaction set:
😭 = "I can't with this", exaggerated reaction (NOT crying)
💀 = "I'm dead", savage disbelief, "I cannot"
🫶 = soft affection, "love you guys"
✨ = vibe marker, sparkle on a moment
👀 = sus, eyeing, "look here", "are you seeing this"
🎀 = coquette, girly, soft princess
🌙 = mysterious, late-night, "ok goodnight"
💖💕🩷 = soft hearts, generic warmth
💋 = flirty mark, kiss-off
🤍 = quiet, soft, peaceful, "no thoughts"
💯🔥 = hot take, facts, "this slaps"

THE HEAVY-ROTATION set (lean on these — they're the "main personality" of the brand):
🤭 = playful coy / "did I really just say that" / sneaky flirty secret / soft mischief / "oops, my bad" — use when revealing something a little spicy, a small confession, a giggle
🥰 = obvious soft adoration / "awwww" / cute overload — use for sweet boy traits, soft confessions, ICK-but-the-good-kind moments
😚 = sweet kiss / peaceful affection / soft "muah" — use for warm endings, signing off, soft love-drops
😜 = playful joking / "lol jk but also not" / cheeky aside — use after a tease so the line lands as fun not mean
🤪 = chaotic / unhinged / "yeah I said it, what" — use for playful chaos, dance reels, "i'm crazy for this" energy
🤗 = warm / "come here" / soft embrace — use for hug-energy moments, fan-love drops, soft welcomes
🥺 = pleading puppy eyes / "pretty pls" / soft want — use for cute requests, mock-begging, "give me attention" moments
😉 = subtle flirt / "you know what I mean" / wink-and-move-on — use after a flirty line where you DON'T want to spell it out
😮‍💨 = dramatic exhale / "phew" / "as I was saying" / "let me breathe" — use after intense lines, "I needed that", overwhelmed-by-cuteness moments

Aesthetic / mood scatter (use as accents):
😋😌🦋💫🌸🍓💞🌷

EMOJI USAGE — STRICT:
- Use 4-6 emojis per caption.
- At least 1-2 of them should come from the HEAVY-ROTATION set above (that's what gives the voice its personality).
- Don't repeat the same emoji twice in one caption.
- Distribute them: some inside the line (after a hook, mid-thought) and some at the end — not all stacked at the very end like a chatbot would.

Example of GOOD emoji distribution:
"boys who say 'text me when you reach home' 🥹 are dangerous 😉 like sir please i was trying to be cool 🤭✨🫶"

Example of BAD (chatbot-tell) distribution:
"boys who say 'text me when you reach home' are dangerous 🥹😉🤭✨🫶"

Same emojis. The first one feels like a real girl typed it. The second feels generated. Always go for the first pattern.


LANGUAGE MIX (the user picks):
- "english": Pure Gen-Z English. NO Hindi words. This is how most viral creators in this niche post — clean English with online slang. Reference: "fold", "rent free", "ate", "delulu", "lowkey", "no bc", "main character", "fr fr".
- "balanced": Mostly English with 1-2 natural Hindi sprinkles per caption. Words like "yaar", "na", "kya", "abhi", "achha", "kuch", "bas", "matlab". Don't force them. If the line doesn't need Hindi, don't add it.
- "hindi-heavy": About 40% Hindi in roman script. Good for OOTD with kurti, festival vibes, mom-coded humor, "ghar wali" moments. Should feel native, not translated.


VOICE MODIFIERS — when the user picks these, lean toward them naturally:
- cute: soft girl, sweet, hearts, "i just want X" energy 🎀💕
- playful: ironic, self-aware. "i bully boys i like" energy
- flirty: tension + observation. Specific trait-namings 👀
- controversial: hot take, "agree or fight me"
- bold: confident main character. "yes i know i'm cute" energy
- mysterious: cryptic one-liners. 🌙💀
- soft: vulnerable journal-style 🤍🥹
- edgy: sarcastic, "i don't care", lowercase, dry
- viral-bait: shareable hooks. "Tag a [type] who..." or universal-observation style


PER-PLATFORM:
- Instagram (≤2200 chars): A bit longer is ok (80-280 chars). Provide 8-15 hashtags as a separate array. Mix high-volume (#reelsindia #fashion #ootd #explorepage #viralreels) with niche (#desigirlies #softgirlaesthetic #indiangirls #cutevibes #brownbabe).
- Threads (≤500 chars): 40-180 chars. One-line punchline > paragraph. Hashtags = empty array.


VARIETY MATTERS:
When asked for multiple captions, make each one genuinely feel different — different shape, different vibe, different energy. Don't just rephrase the same idea. Some short, some slightly longer. Emoji count stays in the 4-6 range across all of them, but the *choice* of emojis should match each caption's mood (e.g. flirty → 👀💋💕✨🫶, mysterious → 🌙💀🤍✨🦋, cute → 🎀💕🥹🌸🩷). Mix the formats above (observation / confession / preference / random / cryptic).


OUTPUT: STRICT JSON only.
{"suggestions":[{"caption":"...","hashtags":["...","..."]}]}
No prose, no markdown fences, no explanation.`;

// ---------- Types ----------

export type CaptionSuggestion = {
  caption: string;
  hashtags: string[];
};

export type SuggestMode = "fresh" | "enhance" | "from-image";
export type LanguageMix = "english" | "balanced" | "hindi-heavy";

export type SuggestOpts = {
  platform: "instagram" | "threads";
  postType: string;
  mode: SuggestMode;
  existingCaption?: string;
  imageUrl?: string;
  voices?: string[];
  languageMix?: LanguageMix;
  userIntent?: string;
  count?: number;
};

// ---------- Suggestion pipeline ----------

export async function suggestCaptions(opts: SuggestOpts): Promise<CaptionSuggestion[]> {
  const n = opts.count ?? 3;
  const maxChars = opts.platform === "threads" ? 500 : 2200;
  const platformNote =
    opts.platform === "threads"
      ? "Threads — no hashtags, conversational, hook-first, one-line punchlines preferred."
      : "Instagram — short caption ok, include 8-15 hashtags array.";

  const voiceList =
    opts.voices && opts.voices.length > 0
      ? opts.voices.join(", ")
      : "playful + cute (default)";

  const langMix: LanguageMix = opts.languageMix ?? "english";

  // Step 1: vision describe (only if from-image + we have OpenRouter + an image).
  let imageDescription: string | null = null;
  if (opts.mode === "from-image" && opts.imageUrl && env.OPENROUTER_API_KEY) {
    try {
      imageDescription = await describeImage(opts.imageUrl);
    } catch (e) {
      // Vision fails => fall back to blind generation with whatever userIntent gives us.
      console.warn("[ai] vision describe failed, falling back:", (e as Error).message);
    }
  }

  // Build the writer's input.
  let modeBlock = "";
  if (opts.mode === "enhance" && opts.existingCaption) {
    modeBlock = `MODE: enhance the user's draft.
User's draft:
"""${opts.existingCaption.replace(/"""/g, "\"\"\"")}"""

Keep the core intent / specific details. Rewrite to nail the brand voice. Generate ${n} distinct rewrites — different vibes but all on-brand.`;
  } else if (imageDescription) {
    modeBlock = `MODE: caption a photo. Here's what's in it (from a vision model):
"""
${imageDescription.trim()}
"""

Write captions that reference what's in the photo naturally — outfit color, mood, setting, pose — without listing or sounding descriptive. Generate ${n} distinct captions.`;
  } else if (opts.mode === "from-image") {
    modeBlock = `MODE: caption a photo (no vision available).
Assume it's a typical OOTD / lifestyle photo for this creator.
${opts.userIntent ? `Photo hint: ${opts.userIntent}` : ""}
Generate ${n} distinct captions.`;
  } else {
    modeBlock = `MODE: fresh suggestions.
${opts.userIntent ? `User context: ${opts.userIntent}` : "Pick a relatable everyday moment or one of the viral hooks (boys observation / POV / preference / confession)."}
Generate ${n} distinct captions.`;
  }

  const userText = `${modeBlock}

LANGUAGE MIX: ${langMix}
VOICE MODIFIERS to blend: ${voiceList}
${opts.userIntent && (opts.mode === "enhance" || imageDescription) ? `Extra context: ${opts.userIntent}` : ""}

Platform: ${platformNote}
Each caption ≤ ${maxChars} characters.

Reminder: study the STYLE EXAMPLES in the system prompt. Match THEIR vibe — short, punchy, English-dominant Gen-Z, real-creator voice, 1-3 emojis. NOT marketing copy.

Return STRICT JSON:
{"suggestions":[{"caption":"...","hashtags":["..."]}]}`;

  const raw = await deepseekChat({
    messages: [
      { role: "system", content: BRAND_VOICE },
      { role: "user", content: userText },
    ],
    temperature: 0.95,
    maxTokens: 1500,
    jsonMode: true,
  });

  let parsed: { suggestions?: CaptionSuggestion[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    parsed = JSON.parse(stripped);
  }
  const out = parsed.suggestions ?? [];
  return out.map((s) => ({
    caption: (s.caption ?? "").slice(0, maxChars),
    hashtags:
      opts.platform === "threads"
        ? []
        : Array.isArray(s.hashtags)
          ? s.hashtags.filter((h) => typeof h === "string").slice(0, 20)
          : [],
  }));
}

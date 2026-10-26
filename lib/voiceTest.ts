// GPT-Live phone test line (concept test, 2026-10-25). One spare Twilio
// number (408-337-2785) is routed over an Elastic SIP trunk straight to
// OpenAI; OpenAI then asks /api/voice-test/incoming whether to pick up, and
// that route accepts the call with the settings below. Audio never touches
// Mission Control — no lead rows, no drips. Recording happens on the Twilio
// trunk (dual-channel), which is what the pause measurements read.
//
// To change how the agent behaves, edit VOICE_TEST_INSTRUCTIONS and deploy.

export const VOICE_TEST_NUMBER = "+14083372785"

export const VOICE_TEST_MODEL = "gpt-live-1"
export const VOICE_TEST_VOICE = "marin"
// Backend "brain" GPT-Live hands harder questions to (billed separately).
export const VOICE_TEST_BACKEND_MODEL = "gpt-6-luna"

// Round 1 — open conversation. Close to the ChatGPT app: no script, no
// business rules; the only question is how it feels over a phone line.
export const VOICE_TEST_INSTRUCTIONS = `You are a friendly, sharp voice assistant on a phone call with Ryan, who owns LRG Homes, a small Bay Area company that buys houses directly from owners. Ryan is testing how you sound over a real phone line, so just have a natural, open conversation about whatever he wants.

Keep replies short and conversational, the way people actually talk on the phone. Don't give long lists or speeches. If he interrupts you, stop and listen. If you didn't catch something, ask him to repeat it.`

// Sent as a developer message at session start so the agent speaks first
// (OpenAI: improves, but doesn't guarantee, a greeting before the caller talks).
export const VOICE_TEST_GREETING =
  `Greet the caller now in English. Say: "Hey, this is the LRG Homes test line. What's up?" Then pause and listen.`

// Telegram heads-up when anyone other than Ryan reaches the test line (there
// is no caller lock — an old-letter caller could land here).
export const VOICE_TEST_OWNER_CELL = "+14085006293"

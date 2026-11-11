// The text someone sent, quoted in a Telegram alert (2026-11-11). The text
// alerts used to stop at 300 characters (250 on the agents line), so a long
// message — Phoenix Chiang's land-buying pitch — reached Ryan cut off mid-
// sentence. Telegram allows 4,096 characters per message; 3,500 leaves room
// for the alert's header lines, so in practice a text always arrives whole.
// The card keeps the full message either way.

export const ALERT_TEXT_MAX = 3500

/** The message for the alert: whole, or cut at ALERT_TEXT_MAX with a pointer to the card. HTML-escaped. */
export function alertQuote(text: string, max = ALERT_TEXT_MAX): string {
  const whole = text.length <= max
  const shown = whole ? text : `${text.slice(0, max).trimEnd()}… (full text on the card)`
  return shown.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

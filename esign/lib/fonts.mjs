// Signature fonts (assets/fonts; OFL except Homemade Apple = Apache 2.0).
// `pick: true` = offered on the signing sheet (2026-11-19: four styles that look clearly different).
// The others stay so signatures already adopted in them still draw exactly as signed.
export const SIGNATURE_FONTS = {
  greatvibes: { label: "Elegant", file: "GreatVibes-Regular.ttf", css: "Great Vibes", webSize: 34, pdfSize: 22, pick: true },
  mrdafoe: { label: "Bold", file: "MrDafoe-Regular.ttf", css: "Mr Dafoe", webSize: 34, pdfSize: 22, pick: true },
  herrvon: { label: "Pen", file: "HerrVonMuellerhoff-Regular.ttf", css: "Herr Von Muellerhoff", webSize: 40, pdfSize: 26, pick: true },
  labelle: { label: "Casual", file: "LaBelleAurore.ttf", css: "La Belle Aurore", webSize: 28, pdfSize: 18, pick: true },
  allura: { label: "Flowing", file: "Allura-Regular.ttf", css: "Allura", webSize: 32, pdfSize: 21 },
  homemade: { label: "Handwritten", file: "HomemadeApple-Regular.ttf", css: "Homemade Apple", webSize: 24, pdfSize: 15 },
  alexbrush: { label: "Brush", file: "AlexBrush-Regular.ttf", css: "Alex Brush", webSize: 34, pdfSize: 22 },
}
export const DEFAULT_FONT = "greatvibes"
export function fontKey(k) {
  return Object.hasOwn(SIGNATURE_FONTS, String(k || "")) ? String(k) : DEFAULT_FONT
}
/** Letters for an initials box from a typed legal name: "Ryan LaRocca" → "RL". */
export function initialsOf(name) {
  return String(name || "").split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase()).slice(0, 3).join("")
}

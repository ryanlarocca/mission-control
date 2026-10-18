// Signature fonts a signer can pick (assets/fonts; OFL except Homemade Apple = Apache 2.0).
export const SIGNATURE_FONTS = {
  greatvibes: { label: "Elegant", file: "GreatVibes-Regular.ttf", css: "Great Vibes", webSize: 34, pdfSize: 22 },
  allura: { label: "Flowing", file: "Allura-Regular.ttf", css: "Allura", webSize: 32, pdfSize: 21 },
  homemade: { label: "Handwritten", file: "HomemadeApple-Regular.ttf", css: "Homemade Apple", webSize: 24, pdfSize: 15 },
  alexbrush: { label: "Brush", file: "AlexBrush-Regular.ttf", css: "Alex Brush", webSize: 34, pdfSize: 22 },
}
export const DEFAULT_FONT = "greatvibes"
export function fontKey(k) {
  return Object.hasOwn(SIGNATURE_FONTS, String(k || "")) ? String(k) : DEFAULT_FONT
}

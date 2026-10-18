// The electronic-records consent shown before a signer can see the document.
// Bump CONSENT_VERSION whenever the wording changes — the version a signer
// accepted is stored on their row and printed on the certificate.
import { env } from "./env.mjs"

export const CONSENT_VERSION = "1"

export function consentParagraphs() {
  return [
    `${env.businessName} would like to send you this document and collect your signature electronically instead of on paper.`,
    `If you agree: you will review the document on this screen and sign it by typing your name. Your electronic signature is as valid as a handwritten one under the federal ESIGN Act and California's Uniform Electronic Transactions Act.`,
    `You can get a paper copy at no charge at any time, before or after signing — just call or text ${env.ownerName} at ${env.ownerPhone} or email ${env.senderEmail}. You will also be emailed a PDF copy of the completed document.`,
    `You can choose not to sign electronically. Tap "I'd rather sign on paper" below and ${env.ownerName} will arrange a paper copy. You may also withdraw this consent at any time before you sign, with no fee, by contacting ${env.ownerName} the same way.`,
    `To use this service you need a device with an internet connection, a web browser, and an email address where we can send your copy. This consent applies to this document only.`,
  ]
}

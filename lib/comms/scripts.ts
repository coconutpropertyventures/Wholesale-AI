// Bradley's approved default outreach scripts for Coconut Property Ventures.
// These strings are APPROVED COPY — keep them character-for-character.
// Do not edit wording here without Bradley's explicit approval; only the
// {first} / {street} placeholders are filled per-recipient.

/** First touch to a listing agent on a stale turnkey listing. */
export const TURNKEY_OPENER =
  "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I work with a network of buyers across the U.S. I saw your listing at {street} has been on the market for a while. Is the seller open to negotiating? Reply STOP to unsubscribe.";

/** Intake questions sent when an agent replies engaged/interested. */
export const TURNKEY_INTAKE =
  "Thanks {first} — few quick ones before I run numbers: (1) any major repairs needed beyond the listing? (2) vacant? if so how long? (3) are the photos current? (4) what's the seller's timeline?";

/** First touch for traditional wholesale (distressed / as-is) listings. */
export const DISTRESSED_OPENER =
  "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I buy houses as-is for cash, even ones needing major work. I saw your listing at {street} — would the seller consider a cash as-is offer below list? I cover all repairs and can close fast. Reply STOP to unsubscribe.";

/** First touch for vacant-land listings (same voice as the house openers). */
export const LAND_OPENER =
  "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I saw your land listing at {street} — is the seller open to negotiating? I can close quickly with cash. Reply STOP to unsubscribe.";

/**
 * Offer-stage message — sent only after intake answers are in. Unlike the
 * openers it carries the calculated initial offer; {offer} is filled with
 * a formatted dollar amount.
 */
export const OFFER_MESSAGE =
  "Hi {first}, Bradley Post with Coconut Property Ventures. I ran the numbers on {street} with my partners — we could do {offer} and close quickly. Let me know if that works for the seller and I'll get paperwork over.";

export type FirstMessageMode = "turnkey" | "traditional" | "land" | "flip";

/** The approved first-message template for an underwriting mode. */
export function firstMessageTemplate(mode: FirstMessageMode): string {
  switch (mode) {
    case "traditional":
    case "flip":
      return DISTRESSED_OPENER;
    case "land":
      return LAND_OPENER;
    default:
      return TURNKEY_OPENER;
  }
}

/** Personalized offer-stage message with a formatted offer amount. */
export function offerMessage(
  first: string,
  street: string,
  offerFormatted: string,
): string {
  return personalize(OFFER_MESSAGE, { first, street })
    .split("{offer}")
    .join(offerFormatted);
}

export interface ScriptVars {
  first?: string;
  street?: string;
}

/**
 * Fill {first} / {street} placeholders in a script template.
 * Tokens without a supplied value are left untouched so a missing
 * personalization is visible rather than silently blank.
 */
export function personalize(template: string, vars: ScriptVars): string {
  let out = template;
  if (vars.first !== undefined) {
    out = out.split("{first}").join(vars.first);
  }
  if (vars.street !== undefined) {
    out = out.split("{street}").join(vars.street);
  }
  return out;
}

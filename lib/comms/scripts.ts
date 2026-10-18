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

// AI-layer access to Bradley's approved outreach scripts.
// The canonical copy lives in lib/comms/scripts.ts (APPROVED COPY — do not
// reword). This module re-exports it and adds small fill helpers used by the
// offers API and the rule-based AI fallback.
import {
  TURNKEY_INTAKE,
  TURNKEY_OPENER,
  personalize,
} from "@/lib/comms/scripts";

export { TURNKEY_INTAKE, TURNKEY_OPENER, personalize };

/** Bradley's approved first-touch turnkey opener, personalized. */
export function turnkeyOpener(firstName: string, street: string): string {
  return personalize(TURNKEY_OPENER, { first: firstName, street });
}

/** Approved intake questions sent after an engaged reply. */
export function turnkeyIntake(firstName: string): string {
  return personalize(TURNKEY_INTAKE, { first: firstName });
}

// Pure helpers for turning a draft request into a stored draft when the
// caller names a contact instead of an explicit recipient (GHL bulk drafts,
// thread replies). Kept side-effect free so they are unit-testable; the
// drafts route does the actual contact lookup and calls these.
import type { Contact } from "@/lib/types";

/** Best first name for personalization: explicit firstName, else the first
 *  word of the full name, else a neutral fallback. */
export function firstNameOf(contact: Contact): string {
  if (contact.firstName && contact.firstName.trim().length > 0) {
    return contact.firstName.trim();
  }
  const firstWord = contact.name?.trim().split(/\s+/)[0];
  return firstWord && firstWord.length > 0 ? firstWord : "there";
}

/** Replace every "{first}" placeholder in a draft template. */
export function personalizeBody(body: string, contact: Contact): string {
  return body.split("{first}").join(firstNameOf(contact));
}

/** Recipient for a contact-addressed draft: phone first (SMS is the primary
 *  GHL channel), then email, then the display name, then the raw id so the
 *  draft always carries SOME traceable destination. */
export function resolveRecipient(contact: Contact): string {
  return contact.phone ?? contact.email ?? contact.name ?? contact.id;
}

/** Full resolution used by POST /api/ghl/drafts for contact-addressed GHL
 *  drafts: recipient + personalized body. */
export function resolveDraftForContact(
  contact: Contact,
  body: string,
): { to: string; body: string } {
  return { to: resolveRecipient(contact), body: personalizeBody(body, contact) };
}

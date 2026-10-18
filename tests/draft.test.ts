import { describe, it, expect } from "vitest";
import {
  firstNameOf,
  personalizeBody,
  resolveDraftForContact,
  resolveRecipient,
} from "../lib/comms/draft";
import type { Contact } from "../lib/types";

function contact(partial: Partial<Contact>): Contact {
  return {
    id: "contact-1",
    organizationId: "coconut-property-ventures",
    feed: "ghl",
    ...partial,
  };
}

describe("resolveRecipient", () => {
  it("prefers phone, then email, then name, then id", () => {
    expect(
      resolveRecipient(
        contact({ phone: "+13175550100", email: "a@b.com", name: "Al" }),
      ),
    ).toBe("+13175550100");
    expect(resolveRecipient(contact({ email: "a@b.com", name: "Al" }))).toBe(
      "a@b.com",
    );
    expect(resolveRecipient(contact({ name: "Al Agent" }))).toBe("Al Agent");
    expect(resolveRecipient(contact({}))).toBe("contact-1");
  });
});

describe("firstNameOf / personalizeBody", () => {
  it("uses the explicit firstName", () => {
    expect(firstNameOf(contact({ firstName: "Jane", name: "Jane Agent" }))).toBe(
      "Jane",
    );
  });

  it("falls back to the first word of the full name", () => {
    expect(firstNameOf(contact({ name: "Bob Smith" }))).toBe("Bob");
  });

  it("falls back to 'there' when no name is known", () => {
    expect(firstNameOf(contact({}))).toBe("there");
  });

  it("replaces every {first} occurrence", () => {
    const c = contact({ firstName: "Jane" });
    expect(personalizeBody("Hi {first} — circling back, {first}.", c)).toBe(
      "Hi Jane — circling back, Jane.",
    );
  });
});

describe("resolveDraftForContact", () => {
  it("resolves recipient + personalized body together", () => {
    const out = resolveDraftForContact(
      contact({ phone: "+13175550100", firstName: "Jane" }),
      "Hi {first}, quick follow-up.",
    );
    expect(out).toEqual({
      to: "+13175550100",
      body: "Hi Jane, quick follow-up.",
    });
  });
});

# Wholesale AI

AI-native command center for real estate wholesaling, turnkey rental acquisitions,
and land flipping. Built for Coconut Property Ventures LLC; designed from day one
for multi-tenant SaaS operation (every record carries an `organizationId`).

## Milestone 1 (built)

- Single-screen dashboard: unified inbox (HighLevel / Gmail / Google Voice feeds),
  property pipeline, deal underwriting, buyer database, AI command box.
- HighLevel API v2 integration (official API, Private Integration token):
  contacts + conversations read; sending only through a single approval-gated
  path with suppression/DND checks and a full audit log. Nothing sends without
  an approved draft.
- Underwriting engine implementing Wholesale Model v3.1 (turnkey / fix-and-flip /
  vacant land): NOI, buyer ceiling, MAO (hard-capped at list price), modeled
  contract from motivation discount tiers, assignment fee as the output, A–F
  grades. Every result lists its assumptions and flags unverified inputs.
- Editable offer drafts generated from approved default scripts, saved to a
  drafts queue with approve/reject. Approved is NOT sent — sending is a
  separate, gated action.
- Automated tests for the financial calculations: `npm test` (17 tests).

## Not yet wired (honest stubs, labeled in the UI)

- Gmail feed: needs your own Google Cloud OAuth client (Gmail API). Milestone 2.
- Google Voice feed: Google offers no official Voice API. Planned relay via
  Gmail notifications (read + reply through the email gateway), labeled beta.
- AI drafting: provider-agnostic (OpenAI / Anthropic / Gemini via env keys).
  With no key, the command box falls back to the approved templates and labels
  its output "rule-based".
- Property data enrichment: optional RentCast API key for rent estimates and
  sale comps. Without it, underwriting inputs are manual and flagged.
- Pipeline counts and the buyer list ship with clearly-labeled DEMO seed data
  until the HighLevel opportunities sync lands.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in server-side secrets; never commit this file
npm run dev                  # http://localhost:3000
```

### HighLevel connection (required for live data)

1. In your HighLevel sub-account (REI Alchemist): Settings → Private
   Integrations → Create. Name: `Wholesale AI`.
2. Scopes (minimum): `contacts.readonly`, `conversations.readonly`,
   `conversations.write`, `opportunities.readonly`, `locations.readonly`.
3. Put the token in `.env.local` as `GHL_PRIVATE_TOKEN` and your sub-account
   ID as `GHL_LOCATION_ID`. Restart the app. The header pill flips to
   "connected" and the inbox shows live contacts/conversations.
   Existing contacts, conversations, SMS number and A2P setup are untouched —
   the app only reads and sends through the official API.

## Production deploy

Any small Node host works (target: one low-cost VPS or free-tier platform):

```bash
npm run build
npm run start        # serves on $PORT (default 3000)
```

Put real secrets in the host's environment, never in the repo. App state
(drafts, audit log, suppressions) lives in `data/store.json` behind a
repository interface, ready to swap for Postgres when multi-tenant billing
lands (Milestone 3: OAuth marketplace app instead of per-user tokens,
subscriptions, per-tenant data isolation enforcement).

## Tests

```bash
npm test             # vitest: underwriting math, discount tiers, grades
npm run typecheck
```

# Wholesale AI

AI-native command center for real estate wholesaling, turnkey rental acquisitions,
and land flipping. Built for Coconut Property Ventures LLC; designed from day one
for multi-tenant SaaS operation (every record carries an `organizationId`).

## Milestones 1–2 (built)

- Single-screen dashboard: unified inbox (HighLevel / Gmail / Google Voice feeds),
  property pipeline, deal underwriting, buyer database, AI command box.
- HighLevel API v2 integration (official API, Private Integration token):
  contacts + conversations read; sending only through a single approval-gated
  path with suppression/DND checks and a full audit log. Nothing sends without
  an approved draft.
- **Live pipeline counts (Milestone 2):** the top stage cards read real
  open-opportunity counts from the HighLevel opportunities API, summed across
  all pipelines by stage name (`/api/ghl/pipeline`, 60-second cache). DEMO
  numbers appear only when HighLevel is not configured, and are labeled DEMO.
- **GHL inbox (Milestone 2):** direction badges (Inbound/Outbound) on every
  conversation, click-to-open thread view, a reply box that saves replies as
  drafts, and multi-select with per-contact personalized bulk drafts
  (`{first}` in a template is replaced with each contact's first name; the
  recipient is resolved server-side from the live contact).
- **Gmail inside the app (Milestone 2):** implemented with the user's own
  Google Cloud OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
  Click "Connect Gmail" in the header or Gmail tab, approve read/send access
  once, and Gmail threads appear in the inbox next to SMS — read a thread,
  save a reply as a draft, approve it, and it sends through the same gated
  send path. OAuth tokens are stored ONLY in an encrypted (AES-256-GCM)
  httpOnly cookie in the user's browser; moving token storage to a hosted
  database is future work.
- Underwriting engine implementing Wholesale Model v3.1 (turnkey / fix-and-flip /
  vacant land): NOI, buyer ceiling, MAO (hard-capped at list price), modeled
  contract from motivation discount tiers, assignment fee as the output, A–F
  grades. Every result lists its assumptions and flags unverified inputs.
- Editable offer drafts generated from approved default scripts, saved to a
  drafts queue with approve/reject. Approved is NOT sent — sending is a
  separate, gated action.
- Automated tests: `npm test` (36 tests — underwriting math, Gmail parsing,
  pipeline aggregation, draft personalization).

## Not yet wired (honest stubs, labeled in the UI)

- Google Voice feed: Google offers no official Voice API. Planned relay via
  Gmail notifications (read + reply through the email gateway), labeled beta.
  Voice drafts are refused explicitly at send time until then.
- AI drafting: provider-agnostic (OpenAI / Anthropic / Gemini via env keys).
  With no key, the command box falls back to the approved templates and labels
  its output "rule-based".
- Property data enrichment: optional RentCast API key for rent estimates and
  sale comps. Without it, underwriting inputs are manual and flagged.
- The buyer list still ships with clearly-labeled DEMO seed data.

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

Store volatility note: the store keeps an in-memory cache and treats the
file write as best-effort, so on a read-only filesystem (e.g. Vercel
serverless) the app runs on memory only — drafts/audit/suppressions then
last only for the lifetime of the serverless instance and can vanish on a
cold start. A hosted database is the fix and is future work; on any normal
writable host the file persists exactly as before.

### Gmail connection (optional, for the Gmail feed)

1. In your own Google Cloud project: enable the Gmail API and create an
   OAuth 2.0 Web application client.
2. Add the authorized redirect URI `<your-app-origin>/api/gmail/callback`
   (or set it explicitly via `GOOGLE_REDIRECT_URI`).
3. Put the client ID/secret in the server env as `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`. Restart/deploy, then click "Connect Gmail" in
   the dashboard header and approve access. Scopes requested:
   `gmail.readonly`, `gmail.send`, `gmail.compose`.

## Tests

```bash
npm test             # vitest: underwriting math, Gmail parsing, pipeline
                     # aggregation, draft personalization
npm run typecheck
```

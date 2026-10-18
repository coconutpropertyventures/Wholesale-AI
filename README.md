# Wholesale AI

AI-native command center for real estate wholesaling, turnkey rental acquisitions,
and land flipping. Built for Coconut Property Ventures LLC; designed from day one
for multi-tenant SaaS operation (every record carries an `organizationId`).

## Milestones 1–3 (built)

- Single-screen dashboard: unified inbox (HighLevel / Gmail feeds),
  property pipeline, deal underwriting, per-thread AI drafting.
- **Layout (Milestone 3):** the Property Workbench (listing data +
  underwriting) sits at the very top of the page, the pipeline cards sit
  under it, and the unified inbox is the dominant full-width section
  directly below, followed by the blast panel and the drafts queue. The
  old fixed bottom AI command bar has been removed — AI drafting now
  lives per-thread in the inbox (see below). The old Buyers card is
  gone from the page.
- **Modes (Milestone 3):** a page-level switch — [Houses | Land], with
  Houses split into [Turnkey | Traditional Wholesale] — persisted in the
  browser and fed into underwriting. Traditional Wholesale is ARV-based:
  buyer ceiling = min(wholesale % (default 70%) × ARV, list price),
  MAO = ceiling − repairs − $15k fee (floored at $0, capped at list),
  fee graded on the same bands as turnkey, and the initial offer goes
  in at MAO.
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
- **Per-thread Send + Draft with AI (both inbox feeds):** directly under
  each thread's composer, **Send** takes the composer's current text and
  runs it through the existing approval-gated machinery — it creates a
  Draft via the drafts API, approves it, and calls the same send endpoint
  as the drafts queue's "Send now" (`lib/comms/send.ts` remains the only
  send path; suppression + live DND checks intact). Typing the text and
  pressing Send IS the approval. A blocked send (e.g. DND) shows the
  reason inline and keeps the text. **Draft with AI** calls
  `POST /api/ai/draft-reply`, which assembles the thread's recent
  messages, the contact's pipeline stages + deal flag, and the
  opportunity's name/value server-side, then drafts a reply in Bradley's
  voice into the composer — it never auto-sends. Reply drafting has no
  template fallback: without `ANTHROPIC_API_KEY` the button says so
  plainly instead of faking a draft.
- **Inbox styles per feed:** both feeds are iMessage-style — a
  scrollable list pane (avatar initials, preview, time, blue unread
  dot) beside the thread with chat bubbles (inbound gray left,
  outbound blue right) and a sticky pill composer that saves replies
  as drafts. The Gmail feed uses the same layout: the thread list
  shows sender / subject + snippet / time, the thread header shows
  the email subject, and bubbles get a wider max-width (85%) for
  long email bodies. Inside every thread, messages render oldest →
  newest with the newest pinned to the bottom — the pane auto-scrolls
  to the bottom when a thread opens and when a new message lands —
  while the conversation lists themselves stay most-recent first.
  (Milestone 3 originally shipped Gmail in a Gmail-style list/reader;
  Bradley reversed that — bubbles everywhere.)
- **Pipeline badges + card filtering (Milestone 3):** every contact shows
  which pipeline and stage each of their open opportunities is in (short
  chips like "Pre-Screening · New Prospect"), a distinct DEAL chip when
  they hold a deal/contract (anything in Dispositions, or Under
  Contract / Closed / Moved to Dispo / Pending Assignment / Deals
  Assigned), and "+N" for extra opportunities; the thread header shows
  all of them. The top cards are grouped by the four real pipelines
  (Pre-Screening, Acquisitions, Dispositions, Wholesale) — clicking a
  stage card filters the inbox to exactly the people in that stage, so
  clicking a Dispositions card shows only the people involved in deals.
- **Gmail inside the app (Milestone 2):** implemented with the user's own
  Google Cloud OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
  Click "Connect Gmail" in the header or Gmail tab, approve read/send access
  once, and Gmail threads appear in the inbox next to SMS — read a thread,
  save a reply as a draft, approve it, and it sends through the same gated
  send path. OAuth tokens are stored ONLY in an encrypted (AES-256-GCM)
  httpOnly cookie in the user's browser; moving token storage to a hosted
  database is future work.
- Underwriting engine implementing Wholesale Model v3.2 (turnkey / fix-and-flip /
  vacant land): NOI, buyer ceiling, MAO (hard-capped at list price), modeled
  contract from motivation discount tiers, assignment fee as the output, A–F
  grades. Every result lists its assumptions and flags unverified inputs.
  **v3.2 ceiling (on-market listings):** turnkey buyer ceiling =
  min(NOI / 5%, list − 5%) — market value (MV) is no longer a ceiling
  term and is computed/displayed as a reference figure only; and in
  both modes the buyer ceiling can never exceed the list price
  (traditional: ceiling = min(wholesale % × ARV, list)). Downstream is
  unchanged: MAO = min(ceiling − $15k, list), fee = ceiling − contract,
  turnkey initial offer = list − 10% after intake. The result panel
  labels which term bound the ceiling ("NOI / 5%" or "List − 5%").
- Editable offer drafts generated from approved default scripts, saved to a
  drafts queue with approve/reject. Approved is NOT sent — sending is a
  separate, gated action.
- Automated tests: `npm test` (120 tests — underwriting math incl. the
  traditional model, Gmail parsing, pipeline aggregation + pipeline map,
  URL parsing, Actor/RentCast row mapping, under-contract matching,
  learning-loop counting, AI cost controls, draft personalization,
  context-dependent model selection, blast auto-approve).

## Property data: sources, costs, and the RentCast gate (Milestone 3)

- **Listing data comes from Apify** (`APIFY_TOKEN`). Two paths, both
  cache-first in the `wai_property_cache` table (7-day TTL) so a property
  is never paid for twice: paste a Zillow/Redfin link into the workbench
  (the address is parsed from the URL slug, then one detail-Actor pull
  fills list price / value estimate / rent estimate / beds / baths / sqft
  / DOM), or run the Redfin search box (city / ZIP / address) and click
  "Run underwriting" on a result card — that path is instant because the
  search results were just cached. Actor IDs are configurable
  (`APIFY_ZILLOW_ACTOR`, default `maxcopell/zillow-detail-scraper`;
  `APIFY_REDFIN_ACTOR`, default `tri_angle/redfin-search`). Actor access
  in the app uses Apify's REST run-sync endpoint; the same Actors are
  exposed to agents through Apify MCP (mcp.apify.com). Costs are
  per-result at Apify's rates (on the order of $1.30–$2.50 per 1,000
  listings) — pennies per property, and only on a cache miss. Without a
  token the UI says so plainly and prefills only what the link itself
  carries; no values are ever fabricated.
- **RentCast is gated to under-contract deals — in code, not by
  convention.** The "Verify with RentCast" button appears only when the
  deal is marked under contract, and `POST /api/deals/verify` re-checks
  server-side before any call: the address must match an open
  opportunity in the Dispositions pipeline, a Wholesale Under
  Contract/Closed opportunity, or an Acquisitions MOVED TO DISPO
  opportunity, otherwise the route returns `not_under_contract` and
  RentCast is never called. Verified values cache for 30 days. Given
  RentCast's small free tier, this keeps paid calls for the deals that
  are actually closing.
- **Draft Realtor Message:** when underwriting pencils, the workbench
  offers "Draft first message" (the approved opener for the mode —
  turnkey, distressed/traditional, or land — with NO offer number) and
  "Draft offer message" (enabled after the intake-received checkbox; a
  short offer text carrying the calculated initial offer). Either can be
  saved as a normal Draft; saving also logs a `wai_message_outcomes`
  row (address, mode, variant, body, offer amount).
- **Learning loop v1 (honest scope):** those outcome rows are the seed
  data. When a logged message's address later matches an opportunity
  that reached DEALS ASSIGNED (Dispositions) or Closed (Wholesale), the
  Drafts list labels the pattern "used on N assigned deal(s)" and the AI
  drafter (below) is fed up to 3 such winning examples. That is the
  entire mechanism today — counting and retrieval, no model training
  and no auto-editing of the approved scripts.

## AI drafting cost controls

Two drafting paths use the model (`lib/ai/draft.ts`): the offer message
(`POST /api/ai/draft-offer`, which falls back to the plain template when
unconfigured) and per-thread replies (`POST /api/ai/draft-reply`, no
template fallback — see the inbox bullet above). First messages/openers
stay pure approved templates with zero model calls. Without
`ANTHROPIC_API_KEY` the helpers report not-configured, stated openly.

- **Context-dependent model selection** (`lib/ai/modelSelect.ts`,
  pure `selectModel(ctx)`): routine pre-deal / pre-contract
  communication drafts on **Haiku** (`AI_DRAFT_MODEL`, default
  `claude-haiku-4-5`). **Sonnet** (`AI_ESCALATION_MODEL`, default
  `claude-sonnet-5`) when ANY of: the contact is on a live deal
  (Dispositions or a contract stage); any of their pipeline stages is a
  deal/contract stage (all Dispositions stages; Acquisitions
  NEGOTIATING / DRAFT AGREEMENT / MOVED TO DISPO / OFFERS MADE;
  Wholesale Under Contract / Closed); the message is an offer; the
  modeled fee is ≥ $25,000; or the property value is ≥ $200,000. The
  offer path routes through the same function with intent "offer".
  Every call logs the chosen model AND the human-readable reason
  ("deal under contract", "negotiation stage", "offer message",
  "fee $X", "property value $X", "routine pre-deal communication") to
  `wai_ai_usage`; the inbox shows the same pair as a chip under the
  composer after an AI draft ("Drafted with Haiku — routine pre-deal
  communication"). `max_tokens` is capped at 220 — these are text
  messages.
- **Per-draft cost:** ~$0.001–0.002 at Haiku rates ($1 in / $5 out per
  1M tokens). The style guide + approved script travel in a
  prompt-cached system block, so on repeat drafts that block bills at
  the cache-read rate ($0.10/1M). Context per draft is property facts +
  the underwriting result + a thread summary + at most 3 winning
  examples and 1 rejected example — never a full thread history.
- **Budget gate:** every call is logged to `wai_ai_usage`
  (model, token counts, purpose). Before each call, the month-to-date
  estimated spend is summed and the call is refused when it would start
  at or over `AI_MONTHLY_BUDGET_USD` (default $25); the UI then falls
  back to the template and says why. The Drafts panel header shows the
  month's estimated AI spend against the budget.

## Blast — texting listing agents at scale

The Blast panel (below the inbox) texts listing agents from the
HighLevel number using Bradley's two approved opener scripts
(`lib/comms/scripts.ts`, sent verbatim with `{first}`/`{street}`
personalization — no other text, no AI rewriting in this path).

**Building a queue.** The workbench results toolbar (above the
Zillow/Redfin result cards) is the primary entry point:
**Send to all** builds a run from ALL properties in the current result
list with the turnkey opener and **auto-approves** it
(`POST /api/blast/runs` with `autoApprove: true`) — the button press is
Bradley's explicit send instruction for that list, the engine starts
on the next tick, and the page scrolls to the Blast panel showing the
run with ready-vs-excluded counts. **Select properties** toggles
selection mode on the result cards (the "Add to blast" checkboxes);
with N selected, **Create blast from selected (N)** builds the run via
the review path (status draft — approved in the Blast panel). Inside
the Blast panel itself, the primary source is the workbench selection:
check "Add to blast" on Zillow/Redfin result cards, then Build queue.
Each selected
property's listing agent is resolved from the cached property detail;
the agent's HighLevel contact is created or found by phone (canonical
per realtor — search by phone first; on create the Listing Street
custom field is stamped), and an opportunity is created in Pre-Screening
· New Prospect when the contact has none for that street. A pipeline
stage is the secondary source (every contact holding an open opportunity
in that stage). Build-time exclusions, each counted in the preview: no
phone on file (`missing_phone` — a phone is never invented), contact on
the suppression list, contact+street already in a live run, and
contact+street already sent via this app within 30 days.

**The rails (all enforced server-side in `lib/blast/pacing.ts` and the
shared engine `stepBlastRun` in `lib/blast/service.ts`):**

- **Approval gate:** building a run sends nothing. Bradley's "Approve &
  start" click is the only thing that makes a run sendable — the single
  exception is the workbench's **Send to all** button, whose press is
  itself the approval for that visible list (the run is created in
  approved status). Either way, no run sends a message its exclusions
  or the pacing rails would block.
- **Pacing:** at least 45s between sends (the engine targets a ~50s
  cadence), in groups of 10 followed by a 180s pause. `POST
  /api/blast/runs/[id]/step` sends at most one item and refuses early
  calls with the wait time.
- **Daily cap:** per run, default 250 sends/day (America/New_York);
  a capped run reports "daily cap reached".
- **DND skip-and-continue:** sends go through the single gated path
  (`lib/comms/send.ts` — suppression check + live HighLevel DND
  re-check). A DND/suppression result marks the item `skipped_dnd` and
  the run continues.
- **Fail-stop:** any other send failure marks the item `failed` and
  auto-pauses the run with the error on it. Nothing else sends until
  Bradley re-approves.
- **Confirmed-send write-backs only:** on a confirmed send, a note with
  the date/time and the exact text sent is added to the agent's contact,
  and that property's opportunity moves to the Contacted stage. Never
  pre-marked.

**Background driver.** Approved runs do not need this tab open: they are
advanced by `POST /api/blast/tick`, which steps every approved/sending
run by at most one due item. The panel only polls status (~15s) to
display progress. There is deliberately **no `vercel.json` cron** — on
Vercel's Hobby plan, built-in cron runs at most once a day, so a minutely
cron block would silently not work. An external scheduler must POST
`/api/blast/tick` about once a minute: options are Vercel Pro cron, a
free external scheduler (cron-job.org, Upstash QStash), or Muse's
scheduler as the interim driver. When `BLAST_TICK_SECRET` is set, the
tick requires it in the `x-blast-secret` header — production should
always set it.

## Not yet wired (honest stubs, labeled in the UI)

- Google Voice: removed from the UI entirely (no inbox tab, no header
  pill) — Google offers no official Voice API, so there is no feed to
  show. The send path still refuses drafts with feed `voice`
  explicitly, and any stored Voice drafts still load in the drafts
  queue.
- AI command endpoint: the bottom command bar UI was removed (AI
  drafting is per-thread now). `POST /api/ai/command` + `lib/ai` remain
  server-side: provider-agnostic (OpenAI / Anthropic / Gemini via env
  keys), falling back to the approved templates labeled "rule-based"
  when no key is set. (Offer/reply personalization is Anthropic-only —
  see the cost-controls section above.)

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

Put real secrets in the host's environment, never in the repo.

### App storage (drafts, audit log, suppressions)

The store (`lib/store/store.ts`) has two backends behind one repository
interface:

- **Postgres — set `DATABASE_URL`.** Production points it at Supabase's
  transaction pooler (port 6543), the right fit for serverless. Tables
  (`wai_organizations`, `wai_drafts`, `wai_audit`, `wai_suppressions`,
  `wai_message_outcomes`, `wai_ai_usage`, `wai_property_cache`)
  bootstrap automatically on first use — no migrations to run — and each
  record is stored whole as JSONB alongside its lookup keys. The default
  organization is seeded on bootstrap if absent.
- **JSON file — `DATABASE_URL` unset.** Local dev and tests use
  `data/store.json` exactly as before, behind an in-memory cache. (The
  property cache falls back to process memory in this mode.)

Store volatility note (file backend only): the cache treats the file write
as best-effort, so on a read-only filesystem (e.g. Vercel serverless
without `DATABASE_URL`) the app runs on memory only —
drafts/audit/suppressions then last only for the lifetime of the
serverless instance and can vanish on a cold start. Setting `DATABASE_URL`
removes the caveat entirely.

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
npm test             # vitest: underwriting math (turnkey + traditional),
                     # Gmail parsing, pipeline aggregation + map, URL
                     # parsing, row mapping, contract matching, learning
                     # counts, AI cost controls, draft personalization
npm run typecheck
```

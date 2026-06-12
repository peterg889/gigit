# Wishlist: Agentic Outreach API for Marketplace Cold-Start

**Date:** June 2026
**Frame:** Everything Gigit would want from an open-source agentic-outreach provider — an API/service we call, where the provider handles the hard parts. Written as a demanding customer's requirements list. If no provider offers this, it doubles as the spec for what we'd assemble ourselves from components.

**Our use cases, concretely:**
- **U1 — Venue acquisition (the hard side):** find every bar/brewery/coffee shop/restaurant in Milwaukee + Pittsburgh, figure out which already program (or should program) live entertainment, reach the decision-maker with an individually-relevant pitch, handle replies, book founder meetings.
- **U2 — Performer seeding:** find local bands/solo acts/comedians from scene signals (venue calendars, IG, Bandcamp, open-mic lineups), invite them to claim a pre-drafted profile.
- **U3 — Tech seeding:** find freelance live sound engineers (the least discoverable population).
- **U4 — Lifecycle re-engagement:** dormant venue hasn't posted a slot in 6 weeks; performer never finished onboarding.

A non-negotiable framing constraint: **in a tight-knit local hospitality scene, one spammy month permanently burns the market.** Most of this wishlist is about making volume *safe*, not making it large. We would rather send 30 excellent messages a week than 3,000 mediocre ones.

---

## 1. Prospecting & enrichment (the intelligence layer)

| # | Requirement | Why we need it |
|---|---|---|
| P1 | **Geo-scoped entity discovery:** `POST /prospects/discover` with a metro polygon + category filters (bar, brewery, coffee shop, restaurant) → deduplicated venue entities with structured attributes (name, address, type, hours, capacity estimate, website, socials). | This list *is* Phase 0. Buying stale lists doesn't cut it. |
| P2 | **Entity resolution across sources.** The same venue on Google, Yelp, Instagram, and its own website must resolve to one record with merged attributes and per-field provenance. | Duplicate outreach to one owner via two "different" records is the fastest way to look like a spammer. |
| P3 | **Signal extraction with evidence:** for each venue, classify "hosts live music / comedy / trivia / nothing" from event calendars, social posts, and review text — returning a confidence score **and the evidence snippets + URLs**. | This is the "% of venues programming live entertainment" stat that doesn't exist publicly (see `metro-selection.md`); it's also our Milwaukee-vs-Pittsburgh tiebreaker AND the personalization fuel. Evidence required because every claim in an outreach message must be checkable (see Q2). |
| P4 | **Decision-maker contact discovery with provenance and verification:** best-channel recommendation (owner email > contact form > IG DM > phone), email deliverability verification, and *where each contact came from*. | Hospitality decision-makers are hard to reach; generic info@ blasts are worthless. Provenance matters for compliance (see C-section) and for not embarrassing ourselves. |
| P5 | **Performer/scene discovery (supply side):** given a metro, mine venue calendars, festival/open-mic lineups, Bandcamp/IG location tags → structured performer prospects (name, genre, media links, observed gig history, best contact). Same for sound techs (harder: mine credits, scene Facebook groups' public pages, production company rosters). | U2/U3. Observed gig history ("played Cactus Club twice this spring") is both a quality filter and the personalization hook. |
| P6 | **Freshness & change-watch:** recrawl cadence I can configure; webhook on "new venue opened matching query" and "venue just started posting live music events." | A brewery that *just* started programming music is the perfect-timing prospect. Timing beats copy. |
| P7 | **Exportable, queryable prospect DB** — full export anytime, no lock-in (it's open source, but the data schema matters: stable IDs, JSONL/Parquet export). | The prospect graph becomes *our* market-intelligence asset (feeds the PRD's F-AI.14 and eventually F-AI.3). |

## 2. Agent definition & message quality (the brand-risk layer)

| # | Requirement | Why we need it |
|---|---|---|
| Q1 | **Declarative agent config:** goal, persona, tone, a knowledge base (our pitch, FAQ, pricing, founder calendar), allowed channels, and **hard guardrails** (claims it may never make, topics it must escalate). Versioned like code. | The agent speaks as Gigit. We need to review its allowed behavior the way we review production code. |
| Q2 | **Evidence-grounded personalization — the hill to die on.** Every prospect-specific claim in a draft must be traceable to a P3/P5 evidence record; the API returns drafts *with citations*; configurable policy: "no evidence → no personalization → fall back to honest generic," never invent. | One hallucinated "loved your Thursday jazz night" (they don't have one) reads as creepy *and* dishonest, and owners talk to each other. Hallucination is the single biggest brand risk in agentic outreach. |
| Q3 | **Pre-send quality gate:** automatic scoring (evidence usage, tone match, length, spam-pattern detection) with a configurable floor; drafts below the floor route to human review regardless of autonomy mode. | Quality variance is what separates "personalized outreach" from "spam with mail-merge." |
| Q4 | **A/B + segment experimentation:** define message variants and audience segments (e.g., breweries-with-music vs coffee-shops-without), with per-variant outcome tracking and significance reporting. | We genuinely don't know whether "fill your Friday" or "prove your music ROI" converts venue owners. The API should let us learn this cheaply. |
| Q5 | **Simulation/sandbox mode:** run the full agent (sequencing, replies, escalations) against synthetic or replayed prospects with zero real sends. | We must be able to test a config change without gambling real venue relationships on it. |

## 3. Orchestration & conversation handling (the agentic layer)

| # | Requirement | Why we need it |
|---|---|---|
| O1 | **Multi-channel sequencing with cross-channel state:** email → wait 4 days → one follow-up → stop (or escalate to a different channel only by explicit config). One conversation state per prospect across all channels. | Touching someone on three channels in one week because the channels don't share state = burned market. |
| O2 | **Autonomy dial, per campaign:** (a) draft-everything-for-approval, (b) auto-send with N% human sampling, (c) full-auto with escalation triggers. We launch at (a), earn our way to (b). | Trust in the agent should be earned with data, and the API should make graduating (and reverting) trivial. |
| O3 | **Reply handling:** classification (interested / question / objection / not-now / unsubscribe / upset), autonomous answers **only from the knowledge base**, automatic meeting booking against a connected calendar, and immediate human escalation for anything off-script, negative, or high-value — with a conversation summary in the escalation. | Founder time should go to interested venues, not inbox triage. But an agent improvising answers about our pricing is how misquotes happen. |
| O4 | **"Not now" as a first-class outcome:** snooze states with scheduled, context-aware resurrection ("you mentioned reconsidering after summer — it's September"). | In this market most "no"s are "not yet." The follow-up six months later, with memory, is where cold-start campaigns actually convert. |
| O5 | **Full conversation transcripts retrievable by API,** linked to prospect IDs, exportable. | These transcripts are our market research — objections are the PRD's backlog priorities. |
| O6 | **Suppression sync with our app:** webhook/API so that a prospect who signs up (or unsubscribes, or becomes a customer) instantly exits all campaigns. Bidirectional: our user DB is a suppression source. | Pitching someone who joined yesterday is the small embarrassment; pitching someone who unsubscribed is the legal one. |
| O7 | **Per-prospect cost and event timeline observability.** | Unit economics of acquisition is a board-level number; we need CAC per channel per segment out of the box. |

## 4. Compliance, deliverability & ethics (the existential layer)

This section is where an open-source provider would earn our adoption. We want the *defaults* to make the right thing the easy thing.

| # | Requirement | Why we need it |
|---|---|---|
| C1 | **Regulatory compliance as enforced defaults, not documentation:** CAN-SPAM (identification, postal address, working unsubscribe), TCPA rules for SMS/calls (prior express consent — i.e., the API should *refuse* cold SMS to consumers and gate B2B texting appropriately), state-law awareness, quiet hours by recipient timezone. | We are not compliance experts and don't want to become ones the hard way. |
| C2 | **Global + per-org suppression lists,** importable/exportable, honored across every channel and campaign, with unsubscribe links/keywords handled by the platform. | Table stakes. |
| C3 | **Hard volume governance:** per-metro send caps, per-domain ramp schedules (warmup), automatic throttle/halt on bounce or complaint spikes, and *no API parameter that overrides the halt*. | We *want* to be rate-limited. A tool that lets an enthusiastic founder nuke a metro in a weekend is a liability. |
| C4 | **Identity transparency enforced:** messages truthfully identify the sender organization; configurable AI-disclosure line; **no fake human personas** — the platform should refuse persona impersonation by design. | Bot-disclosure laws are spreading, and more importantly: our entire brand position (per the PRD anti-requirements) is transparency. The outreach must match. |
| C5 | **Platform-ToS honesty per channel:** the provider exposes which channels are automatable within terms (email: yes; Instagram DMs: largely no) and declines or clearly risk-flags gray-area automation rather than silently doing it. | An IG ban on Gigit's account during launch month would be catastrophic. We'd rather the API tell us "this channel requires a human" — and queue it as a human task (see O3) — than pretend. |
| C6 | **Deliverability infrastructure managed:** SPF/DKIM/DMARC setup guidance/automation, bounce processing, reputation monitoring, dedicated sending domains kept separate from our product transactional domain. | Cold outreach must never endanger booking-confirmation deliverability — those emails are the product. |
| C7 | **Immutable audit log** of every message, decision, and config version that produced it; exportable. | If a venue owner says "your bot said X," we need to know in 30 seconds whether it did, and which config version was responsible. |

## 5. Developer experience & openness (why open source specifically)

| # | Requirement | Why we need it |
|---|---|---|
| D1 | **Self-hostable with full data ownership;** our prospect graph, transcripts, and outcomes never train anyone else's models. | The prospect/outcome dataset is part of *our* moat (see `ai-era-features.md` §1.2). |
| D2 | **Model-agnostic / bring-your-own-model:** configurable model per task (cheap model for classification, frontier model for drafting), with per-task cost controls. | Drafting quality and cost both matter; we want to tune the tradeoff, not inherit it. |
| D3 | **Boring API ergonomics:** REST + webhooks, idempotency keys, sandbox keys, stable pagination, good errors, OpenAPI spec, first-class TypeScript/Python SDKs. | We're a tiny team; integration time is real money. |
| D4 | **Workspaces/multi-tenancy per metro** with shared global config and per-metro overrides (different anchor-venue lists, local references, caps). | The whole GTM is metro-by-metro; the tool should mirror that shape. |
| D5 | **Everything-as-config in version control:** agents, sequences, guardrails, knowledge bases exportable as files; CI-able (run the Q5 simulation suite on config PRs). | Outreach behavior changes should go through review like any other production change. |
| D6 | **Composable, not monolithic:** the enrichment layer (§1), agent layer (§2–3), and sending/compliance layer (§4) usable independently behind clean interfaces. | If the provider's enrichment is weak in second-tier metros, we want to swap in our own scraper without forfeiting the rest. |

## 6. Explicitly out of scope (we'd build these ourselves)

- **The pitch and positioning** — knowledge-base content is ours.
- **Anchor-venue closing** — the 25 launch venues are founder-led human relationships; the API's job there is research briefs and scheduling, not selling.
- **In-product activation flows** (claimed-profile onboarding, F1.8) — product, not outreach.
- **The decision of who to contact** — scoring/targeting policy stays in our code; the API executes.

## 7. Acceptance test (how we'd evaluate a real provider)

A one-week pilot in one metro must demonstrate: (1) ≥80% precision on "this venue currently programs live entertainment" against a 50-venue hand-checked sample; (2) zero unevidenced prospect-specific claims across 100 reviewed drafts; (3) a reply correctly classified and escalated with usable summary in <5 min; (4) unsubscribe honored across channels instantly; (5) volume halt triggers correctly on a simulated complaint spike; (6) full export of everything we put in.

---

## Appendix: API surface sketch

```
POST   /prospects/discover            {geo, categories, signals[]}        → job → prospect[]
GET    /prospects?segment=...                                              (query + export)
POST   /prospects/{id}/enrich         {signals: [contacts, live_music_evidence]}
POST   /watches                       {query, webhook_url}                 (new-prospect / signal-change alerts)

PUT    /agents/{id}                   {persona, knowledge_base_ref, guardrails, channels[]}
POST   /campaigns                     {agent_id, segment, sequence, autonomy: draft|sampled|auto,
                                       caps: {per_day, per_metro}, experiment: {variants[]}}
POST   /campaigns/{id}/simulate       {synthetic_prospects | replay_range}  → transcript report
GET    /drafts?status=pending_review  → draft[] {body, citations[], quality_score}
POST   /drafts/{id}/approve | reject  {feedback}

POST   /webhooks                      reply.classified | meeting.booked | escalation.raised |
                                      prospect.unsubscribed | campaign.halted | prospect.signal_changed
GET    /conversations/{prospect_id}   → full transcript + state + cost
POST   /suppressions                  {emails[]|ids[], scope: global|org}   (+ bidirectional sync API)
GET    /audit?from=...                → immutable event log export
GET    /metrics?campaign=...          → sends, replies, positive_rate, meetings, CAC by variant/segment
```

**Priority if we can't have it all:** §4 (compliance/safety) and Q2 (evidence grounding) are non-negotiable; §1 (enrichment with evidence) is the biggest value-add; §3 can start minimal (draft-for-approval + manual sending covers week one); §2's experimentation and §5's composability are what make it durable.

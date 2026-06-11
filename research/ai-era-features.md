# AI-Era Features: What's Possible Now That Wasn't in 2007–2015

**Date:** June 2026
**Context:** Every prior entrant in this category (Sonicbids 2001, GigSalad 2007, GigMasters 1997, GigTown 2015, Gigmor 2014) was built when curation, support, sales, and content production required human headcount that scaled linearly with the marketplace. GigFinesse (2019) differentiates with a human concierge team — its costs scale with bookings. This doc enumerates what an AI-native build changes, ranked by how defensible and how load-bearing each capability is.

**The one-sentence thesis: AI doesn't just make Gigit cheaper to build — it makes the *concierge experience* (the thing venues actually pay GigFinesse for) deliverable at self-serve marketplace cost.**

---

## 1. The strategic frame (read this before the feature list)

1. **The historical cost structure was the constraint, not the idea.** Matching bands to venues was never technically hard; what killed or capped everyone was the human cost of (a) curating quality at scale, (b) supporting low-value transactions ($150 gigs can't fund support tickets), (c) selling to thousands of small venues one phone call at a time, and (d) producing promotion for each gig. All four are now near-zero-marginal-cost.
2. **AI features are not a moat — every competitor gets the same models.** GigFinesse can bolt on an LLM tomorrow. The durable advantages are: (a) **the outcome dataset** — which acts actually filled which rooms on which nights at what price (no one has this; it only accrues to whoever processes the bookings), and (b) **structured supply data** (verified gear inventories, stage specs, input lists) that generic models can't conjure. Every feature below should be evaluated partly on "does it feed the dataset?"
3. **Don't ship gimmicks.** Features marked ⚠️ below are tempting but either erode trust (AI-generated performer content), are premature (full autonomous negotiation), or solve non-problems. Listed so we consciously reject them.

---

## 2. The standout: the ROI loop (genuinely impossible before)

**F-AI.1 — POS-integrated ROI measurement.** The bar owner's math (from research: "$500 band needs ~$2,500 incremental gross") has never been measurable per-act. Toast, Square, and Clover all have public APIs now. Venue connects POS → Gigit compares gig-night revenue vs. matched baseline nights → every booking gets a receipt: *"The Hollow Points lifted your Friday net 22% (+$640). Comedy Tuesdays average +$310 in your room."*

- **Why impossible before:** restaurant POS data was locked in on-prem systems until the cloud-POS wave (Toast IPO'd 2021); the per-act attribution analysis required an analyst, now it's an automated pipeline plus an LLM-written narrative.
- **Why it's the killer feature:** it converts live entertainment from a *faith-based expense* into a *measurable channel* — directly attacking the #1 reason venues quit programming (unproven ROI). It also makes Gigit's own pricing trivially defensible ("we charge $10; the band made you $640").
- **Second-order effects:** ROI data per act = the matching algorithm trains on *business outcomes*, not clicks; high-ROI performers get a portable, evidence-based "draw" credential (nobody in the industry has ever been able to prove draw); metro-level "what works on Tuesdays" intelligence compounds into the dataset moat.
- **PRD placement:** P1, flagship of Phase 2. (Needs booking volume first; build the baseline-comparison pipeline early so history accrues from day one.)

---

## 3. Venue-side features (the buying side, where friction kills)

**F-AI.2 — Natural-language / SMS-native slot posting.** Dana texts a number: *"need something chill for Sunday brunch, $200ish"* → structured slot (date, format, budget, duration inferred from her venue profile) → confirmation text. Venue managers live in their POS and their texts, not in apps — the research showed unresponsive/busy bookers are a top complaint on both sides.
*Before:* forms, dropdowns, an app to download. *Now:* one LLM call to parse, one to confirm. **P0 candidate** — this is cheap and removes the single biggest demand-side activation hurdle.

**F-AI.3 — AI talent buyer ("what should I book?").** The venue's real question isn't "who is available" but "what works in a room like mine." An agent that knows the room (capacity, vibe, neighborhood, past outcomes + metro-wide outcome data) proposes a program: *"Rooms your size within 2mi do best with acoustic duos Thu, full bands Fri; here are 5 available acts in budget, ranked, with 30-second highlight reels."* This is literally GigFinesse's human concierge, delivered at software margins.
*Before:* required a human booker's judgment. *Now:* retrieval + outcome data + LLM. **P0 in degraded form** (good defaults from structured matching), gets better as F-AI.1 data accrues.

**F-AI.4 — Auto-generated gig promotion.** Confirmed booking → poster (venue branding + act photos), IG/FB post copy, a 20-second vertical clip auto-cut from the act's own video with event details overlaid, Google Business event, Bandsintown listing, email blurb for the venue's list. Research finding: under-promotion is a leading cause of failed nights (Nathan Timmel's venue guide; Ticket Fairy postmortems).
*Before:* a designer + social manager per venue — impossible at $150-gig economics. *Now:* templated generation, near-zero marginal cost. **P1, high retention value.** Constraint: only ever use the act's *real* media — generation assembles, never fabricates.

**F-AI.5 — Compliance copilot.** Conversational onboarding that resolves the venue's actual obligations (PRO licenses by room size/format, local entertainment permit, noise curfew from municipal code lookup) into a checklist with dollar estimates — the research showed this is a fear-and-confusion zone ($1,500+/yr, lawsuits, four PROs). Static guidance is P0 (already in PRD); the conversational/local-lookup version is P1. Always labeled guidance-not-legal-advice.

**F-AI.6 — Programming calendar intelligence.** Cross-reference local event calendars, sports schedules, weather, and metro outcome data to flag *"home game Friday — book louder; first warm Saturday — patio acoustic sells."* P2; needs F-AI.1 data to be more than astrology. ⚠️ Ship only when it's actually predictive.

---

## 4. Performer-side features (supply activation and fairness)

**F-AI.7 — Link-in, not type-in onboarding.** Performer pastes one URL (Instagram/Bandcamp/YouTube/Linktree) → agent assembles the full profile: bio draft, genre tags, media embeds, set-length inference, even tech needs guessed from stage videos (visible instrument count → input estimate), all shown for confirmation/edit. Target: complete bookable profile in **under 5 minutes from one link**.
*Before:* EPK assembly was the activation wall (Sonicbids' whole business was charging for EPK hosting). *Now:* scraping + multimodal extraction. **P0 — this is how 150 performers get seeded in Phase 0 without data entry.** Rule: AI *drafts*, performer *approves*; never publish unconfirmed.

**F-AI.8 — Audio/video understanding for matching and quality.** Embed every act's actual audio/video: genre/mood vectors (matching a "chill brunch" slot on *sound*, not self-reported tags), basic quality signals, and **auto-generated 30-second highlight reels with normalized loudness** so a venue can compare five applicants in two minutes.
*Before:* Sonicbids-era curation = human A&R listening; venues just guessed. *Now:* audio embeddings are commodity. **P1** (P0 ships with self-reported tags). Also the integrity layer: detection of AI-generated "acts," stolen media, and stock-footage profiles — a new fraud class that *didn't exist* for our predecessors and that we uniquely must solve. That detection duty is **P0**.

**F-AI.9 — Agentic gig manager for performers.** Within performer-set bounds ("Fridays, $400+, ≤30mi"), an agent watches the feed, applies, holds calendar tentatives, drafts replies, and chases confirmations. The marketing line writes itself: *"every band gets a booking agent."*
*Before:* booking agents take 10–15% and only work for acts that already draw. *Now:* an LLM loop. **P1.** ⚠️ Guardrail: agent *proposes*, human *confirms* any commitment — autonomous double-booking would destroy exactly the reliability the platform sells.

**F-AI.10 — Rate transparency engine.** Synthesized from platform bookings: *"acoustic duos in your metro: $250–$350 for 2hr Fri slots; your profile supports asking $300."* Kills the negotiate-from-zero problem and operationalizes the pay-transparency policy. **P1**; needs ~1 quarter of booking data per metro.

---

## 5. Sound-tech-side features (our novel side, made viable by AI)

**F-AI.11 — Photo-to-specs gear and room ingestion.** The sound-plan engine (PRD F6.1) needs structured data nobody wants to type. Venue snaps photos of their "PA closet" and the room → multimodal model drafts the inventory (mixer model/channels, speaker types, mic count) and room characteristics; tech photographs their rig → rig spec sheet. Human confirms.
*Before:* structured gear data was the unbuildable prerequisite — this is plausibly *why* no sound-tech marketplace ever existed (the matching inputs were never capturable at scale). *Now:* a photo and a confirmation tap. **P0 — this feature is load-bearing for the entire third side.**

**F-AI.12 — Auto-generated show specs.** From performer tech needs + venue inventory: input list, stage plot draft, and a plain-English brief for the tech (*"4-piece, vocals-only through house PA, bring 2 monitors"*). The tech's stated core unmet need ("know what I'm walking into") solved as a side effect of data the booking already contains. **P0-adjacent** (v1 can be a structured summary; generation is polish).

---

## 6. Platform/ops features (the cost-structure advantage itself)

**F-AI.13 — AI-first support and dispute resolution.** First-line support fully conversational; disputes get an evidence pack auto-assembled from the booking record (messages, timestamps, contract terms, photos) with a *drafted* adjudication for human sign-off. Target from PRD: <1 human touch per 20 bookings — that target is only writable because of this.
*Before:* support economics forbade low-value transactions; GigSalad solved it by being hands-off (and is reviled for it). *Now:* concierge-grade support at $150-gig economics. **P0.**

**F-AI.14 — AI SDR for venue acquisition.** Already in PRD Phase 0: scrape metro venue lists + their actual event calendars/IG → individually-relevant outreach (*"saw you ran trivia but no music since March…"*), drafted for human review at launch volume, with reply-handling and meeting-booking. Also continuous **prospect intelligence**: which venues in the metro already host live entertainment (event calendar scraping) = the exact survey the research doc said was missing, run as software instead of fieldwork. **P0 (it's the go-to-market).** ⚠️ Keep volume low and quality high — spam burns a small-city hospitality scene permanently.

**F-AI.15 — Voice agent for confirmations.** Day-before confirmation calls to venues that don't text back ("press 1 if Friday is still on") and an inbound line that answers "is my band confirmed?" Old-school owners are phone people. **P2** — cheap now, but test whether SMS suffices first. ⚠️ Must self-identify as automated.

---

## 7. Consciously rejected (the gimmick list)

| Tempting idea | Why we say no |
|---|---|
| AI-generated performer photos/demo polish | Misrepresentation is the marketplace's #1 trust risk; we *detect* this, never enable it |
| Fully autonomous negotiation (agent-to-agent booking with no human confirm) | One double-booking scandal outweighs years of convenience; humans confirm commitments until reliability data says otherwise |
| AI booking chatbot as the *only* interface | Power users (producers booking 10 lineups/month) need dense UI, not conversation |
| Dynamic surge pricing of performer pay | Performers aren't Uber drivers; algorithmic pay-setting recreates the Sofar opacity problem we're positioned against |
| AI-composed background music tier for venues | Different business, alienates the supply side existentially |

---

## 8. Summary: revised cost equation and PRD deltas

What the incumbents needed headcount for → what it costs Gigit:

| Function | 2010s cost | AI-era cost | Feature |
|---|---|---|---|
| Talent curation | A&R team (Sonicbids) | Audio embeddings + outcome data | F-AI.8 |
| Concierge matching | Ops team (GigFinesse, scales with bookings) | Agent + retrieval | F-AI.3, F-AI.9 |
| Venue sales | Phone-call SDR army | AI SDR + founder closing | F-AI.14 |
| Support | Forbidden by unit economics | AI-first, human escalation | F-AI.13 |
| Per-gig promotion | Designer + social manager (nobody even tried) | Generation pipeline | F-AI.4 |
| ROI proof | Impossible (on-prem POS) | Cloud-POS APIs + automated attribution | F-AI.1 |
| Sound-tech data capture | Unbuildable prerequisite | Photo → specs | F-AI.11 |

**Proposed PRD changes (pending your review):**
- Promote to P0: F-AI.2 (SMS slot posting), F-AI.7 (link-in onboarding), F-AI.11 (photo-to-specs), F-AI.13 (AI-first support), F-AI.8's fraud-detection half. F-AI.14 is already P0 in the launch plan.
- Name F-AI.1 (POS ROI loop) the Phase 2 flagship and start accruing baseline data at MVP.
- Add §7's rejected list to the PRD as explicit anti-requirements (trust policy).

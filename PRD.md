# Gigit — Product Requirements Document (v0.1)

**Status:** Draft for review
**Date:** June 2026
**Companion doc:** [`research/competitive-landscape.md`](research/competitive-landscape.md) — competitor research and sourcing for every market claim referenced here.

---

## 1. Problem statement

Small hospitality venues (restaurants, coffee shops, bars, breweries) want live entertainment because it drives traffic, but booking it is a fragmented, relationship-gated mess: finding acts means Instagram DMs, Craigslist, and word of mouth; assessing quality is guesswork; cancellations leave holes that get filled with "lower quality or ill-fitting acts"; and the surrounding logistics (contracts, payment, sound) are entirely manual.

Local bands, solo musicians, and stand-up comedians have the mirror problem: the venues that would host them are invisible, bookers are unresponsive, pay is opaque and negotiated from scratch every time, and getting paid is slow and informal.

Live sound techs — required for most amplified shows, since many small venues have no house PA — have no marketplace at all. Work is found through personal networks that take years to build and reset when you move cities.

**Gigit is a three-sided marketplace where venues post entertainment slots, performers (bands and comedians) book them, and sound techs (with or without PA rigs) attach to those bookings — with contracts, payments, scheduling, and promotion handled by the platform.**

### Why now / why this is winnable
- The profitable incumbents (GigSalad, The Bash) serve private-event planners, not recurring venue programming.
- The one funded US competitor (GigFinesse, ~$15M total funding) is concierge-style, opaque, music-only as of 2026, and has no sound-tech side.
- GigPig (UK) has proven the venue-pays self-serve model at 100,000+ gigs booked, and hasn't entered the US.
- Nobody integrates sound techs, and comedy booking for bars/breweries is still run by human producers.

## 2. Goals and non-goals

### Goals (12 months)
1. Achieve booking liquidity in **one launch metro**: ≥70% of posted slots filled, median time-to-fill <72 hours.
2. Make Gigit the lowest-friction way for a small venue to run a recurring entertainment program (weekly music night, monthly comedy night) end to end.
3. Make the platform the *better-than-cash* way to transact: confirmed bookings, automatic contracts, guaranteed payment timing, no-show protection.
4. Onboard sound techs as bookable, attachable resources on gigs — the industry's first.

### Non-goals (v1)
- Ticketing and consumer-facing event discovery (syndicate to Bandsintown/Google instead; revisit in v2).
- Dedicated music venues with in-house talent buyers (Opendate/Prism territory).
- Private events (weddings/corporate) — GigSalad/The Bash territory; revisit as an expansion revenue lever later.
- National coverage. One metro until liquidity metrics are hit.
- Becoming the promoter (Sofar model). Gigit never owns the show, the door, or the audience relationship.
- Artist development features (EPK hosting beyond what booking requires, fan followings, streaming embeds beyond profile media).

## 3. Users and personas

| Persona | Profile | Core jobs-to-be-done |
|---|---|---|
| **Venue manager "Dana"** | Owns/manages a brewery taproom; no music background; books 4–8 events/month between other duties | Fill my Friday slot with something good for my room and budget; don't make me chase anyone; protect me if they cancel; tell me what licenses I need |
| **Band leader "Marcus"** | Fronts a 4-piece covers/originals band; day job; plays 2–6 gigs/month at $400–$800/band | Find venues that actually book acts like mine; stop negotiating from zero; get paid same-week without awkwardness; land repeat slots |
| **Solo performer "Priya"** | Acoustic singer-songwriter; coffee-shop circuit; $75–$150+tips/set | Low-stakes discovery; fill weekday slots; tips |
| **Comedian "Jess"** | 5 years in; hosts/features; produces a monthly bar show | Find rooms that want comedy; book lineups fast; split payouts with the other comics on the bill |
| **Sound tech "Sam"** | Freelance live engineer with a small PA rig in a van | Fill empty dates; stop depending on word of mouth; get paid promptly; know exactly what the room/band needs before showing up |

Secondary: **comedy/music producer** (books lineups of multiple acts into a slot — power user of the comedian flow); **Gigit ops admin** (internal).

## 4. Business model

Informed directly by the competitive research (§7 and §11 of the research doc):

1. **Free for performers and sound techs. Forever. No fee to join, apply, or message.** Charging the supply side to apply is the historically fatal mistake (Sonicbids).
2. **Free (or near-free) for venues until momentum.** AI-leveraged development, support, and outreach give Gigit a structurally lower cost base than any prior entrant in this category (GigFinesse carries a concierge ops team; GigTown burned $2M subsidizing liquidity). We spend that advantage on the hardest problem — liquidity — by removing all price friction at launch. Payment processing margin (see #3) provides modest revenue from day one, so "free" ≠ zero revenue.
3. **Payment processing margin:** all gig payments flow through Stripe Connect; Gigit prices in a small processing spread. This is the only monetization until momentum triggers fire.
4. **Monetization triggers, not a timeline.** Venue pricing (low flat per-gig fee ~$5–15 and/or a low subscription ~$19–49/mo) switches on per-metro only when: fill rate ≥70% for 8 consecutive weeks, ≥100 bookings/month in metro, and venue 90-day retention ≥60%. Existing venues get grandfathered pricing for 12 months — early adopters should never feel punished for joining early.
5. **Price to stay cheap forever.** Even post-momentum, pricing stays well below the value of one filled slot and below GigPig's £15/gig benchmark. The AI-driven cost structure means we don't need GigSalad-style subscription tiers or 5% takes to be sustainable; low price is itself the anti-disintermediation strategy (cheaper to stay than to leave).
6. **Pay transparency is policy:** every slot shows the budget; every party sees what every other party is paid on their booking. (Sofar's opaque-spread model produced lasting damage; transparency is our wedge and a trust moat.)

## 5. The marketplace model

- **Demand posts, supply applies — plus direct invite.** Venues post **slots** (date, time, duration, genre/format, budget, room details). Performers apply with one tap (profile = application — no essays). Venues can also browse/search performers and invite them to a slot. This is the GigPig/Open Comedy interaction model, chosen over GigSalad's reverse-auction quoting (which produces race-to-the-bottom dynamics performers hate) and over GigFinesse's concierge matching (which doesn't self-serve scale).
- **Sound techs attach to bookings** (see F6): a booking that needs sound generates a tech sub-slot either party can fund.
- **Recurring slots are first-class** (weekly music night, monthly comedy night) — recurrence is the core venue habit we monetize, so the product must treat a series, not the one-off gig, as the unit of venue value.

---

## 6. Functional requirements

Priorities: **P0** = MVP launch blocker; **P1** = fast-follow (first 1–2 quarters post-launch); **P2** = later.

### F1. Accounts, profiles, verification

| # | Requirement | Priority |
|---|---|---|
| F1.1 | Three account types — **Performer** (subtype: band / solo musician / comedian / other), **Venue**, **Sound tech**. One human can hold multiple roles (a comedian who produces; a musician who does sound) under one login. | P0 |
| F1.2 | **Performer profile** = lightweight EPK: name, genre/format tags, home metro + travel radius, bio, photos, 1–3 media links (YouTube/audio embeds), set lengths offered, standard rate range, typical stage/tech needs (input count, vocal-PA-only vs full backline, stage plot upload optional). | P0 |
| F1.3 | **Venue profile**: type (bar/restaurant/coffee shop/brewery/other), capacity, room photos, stage/performance area dimensions, **house PA & gear inventory** (structured checklist: PA yes/no, mixer channels, mics, monitors, who runs sound), typical audience, parking/load-in notes, hospitality offered (meal/drinks tab), noise constraints/curfew. | P0 |
| F1.4 | **Sound tech profile**: experience summary, gear offered (none / partial / full PA rig with specs: speakers, mixer, mic package, monitors), rates (labor-only vs with-rig), travel radius, credits/references. | P0 |
| F1.5 | Identity verification (email + phone) at signup; Stripe identity verification before first payout. | P0 |
| F1.6 | Badges earned from platform behavior: gigs completed, on-time rate, response rate. No pay-to-rank placement, ever. | P1 |
| F1.7 | COI (certificate of insurance) upload on performer/tech profiles; venues can require COI per slot; expiry tracking. | P1 |

### F2. Slot posting & discovery

| # | Requirement | Priority |
|---|---|---|
| F2.1 | Venue posts a **slot**: date(s), start time + duration, entertainment type (live music / comedy / either), genre/format preferences, budget (required — pay transparency is policy), what's provided (PA, meal, drinks, parking), audience expectations. Posting flow ≤3 minutes. | P0 |
| F2.2 | **Recurring slot series** (e.g., every Friday; first Tuesday monthly) with per-occurrence overrides. | P0 |
| F2.3 | Performer-facing **gig feed**: filter by date, distance, pay, format; saved-search alerts (push/email) for matching new slots. | P0 |
| F2.4 | Venue-facing **performer search**: filter by format/genre, availability, rate range, distance; invite-to-slot action. | P0 |
| F2.5 | One-tap **apply** (profile is the application; optional short note). Venue sees applicant list with profiles, media, badges, and reviews inline. | P0 |
| F2.6 | Comedy **lineup support**: a slot can request multiple acts (host + feature + headliner with per-act pay), and a producer-role performer can apply with a packaged lineup. | P1 (single-act comedy slots are P0) |
| F2.7 | Matching/ranking algorithm v1 = filters + recency + reliability score. ML recommendation later. | P0 (v1), P2 (ML) |

### F3. Booking flow & contracts

| # | Requirement | Priority |
|---|---|---|
| F3.1 | Venue selects an applicant → **offer** with locked terms (date, time, set length, pay, what's provided) → performer accepts → booking confirmed. Any term change re-requires both-party confirmation. | P0 |
| F3.2 | Confirmation auto-generates a **performance agreement** from a standard template (parties, terms, cancellation policy, rider items from the profiles' tech needs), e-signed by both sides in-flow. | P0 |
| F3.3 | **Cancellation policy** (platform default, industry-norm-based): venue cancels >14 days out — no charge; 48hrs–14 days — 50% to performer; <48hrs — 100% to performer. Performer cancels — slot auto-reposted with priority + reliability score hit; repeated late cancels → suspension. | P0 |
| F3.4 | **Replacement engine:** on any cancellation, the slot is instantly re-broadcast to matched, available performers as an urgent fill (the venue's worst pain point per research). | P1 |
| F3.5 | Day-of-show runsheet auto-shared with all parties: load-in time, contact phones, set times, gear summary, payment status. | P1 |
| F3.6 | Calendar: per-user availability calendar; confirmed bookings sync out via iCal/Google Calendar. | P0 (in-app + iCal out), P1 (two-way sync) |

### F4. Payments

| # | Requirement | Priority |
|---|---|---|
| F4.1 | **Stripe Connect** (separate charges & transfers + manual payouts — Stripe offers no true escrow; this is the standard marketplace pattern). Venue's card/ACH charged at confirmation; funds held in platform balance; **auto-released to performer/tech 24h after gig end** unless a dispute is opened. | P0 |
| F4.2 | Performer marks "gig played" / venue non-action auto-confirms at +24h; dispute window pauses release. | P0 |
| F4.3 | **Band split payouts:** band accounts can define member splits; one booking → N payouts. Same mechanism covers comedy lineup splits to multiple comedians. | P1 (launch with single payout to the booking owner) |
| F4.4 | Tax compliance: W-9/TIN collection via Stripe at onboarding; 1099-K issuance at federal thresholds (>$20K and >200 txns post-OBBBA) **and** lower state thresholds (MA/MD/NJ etc.). | P0 |
| F4.5 | Instant payout option (small fee) vs free standard payout. | P2 |
| F4.6 | Tip jar: QR code on the day-of runsheet → direct tips to the performer (Gigit takes nothing on tips). | P2 |

### F5. Messaging & notifications

| # | Requirement | Priority |
|---|---|---|
| F5.1 | In-platform messaging scoped to applications and bookings; full contact details revealed at confirmation (phone numbers needed day-of). | P0 |
| F5.2 | Push + email + SMS for the critical path: new matching slot, application received, offer, confirmation, day-before reminder, payment released. Venue managers live in their POS, not our app — SMS matters. | P0 |
| F5.3 | Response-time tracking surfaced on profiles ("usually responds in X hours") — unresponsive bookers are a top performer complaint. | P1 |

### F6. Sound tech integration (the differentiator)

| # | Requirement | Priority |
|---|---|---|
| F6.1 | At slot creation, the system computes a **sound plan** from structured data: venue's house PA inventory × performer's tech needs → "covered" / "tech needed" / "tech + rig needed". | P0 |
| F6.2 | If sound is needed, either party can add a **tech sub-slot** to the booking with its own budget; payer is explicit (venue or performer; venue-pays encouraged by default UX). Techs discover and apply to tech sub-slots exactly like performers apply to slots (same feed, same one-tap apply, same payment rails, same reviews). | P0 |
| F6.3 | Tech sub-slot inherits gig context automatically: room specs, input list from the performer's profile, set times — "know exactly what I'm walking into" is the tech's core unmet need. | P0 |
| F6.4 | Standing venue↔tech relationships: a venue can designate a house tech who auto-attaches to its bookings. | P1 |
| F6.5 | Standalone tech bookings (band hires a tech for an off-platform gig; venue hires a tech to install/tune a house PA) — keeps tech-side liquidity healthy independent of slot volume. | P2 |

### F7. Reviews & trust

| # | Requirement | Priority |
|---|---|---|
| F7.1 | Double-blind post-gig reviews (each side reviews; published simultaneously or at +7 days). Venue→performer: draw/professionalism/quality. Performer→venue: hospitality, accuracy of listing, payment promptness (auto-five-star via platform pay). Tech reviewed by both. | P0 |
| F7.2 | Reviews only from completed platform bookings — no drive-by reviews (a top performer complaint about GigSalad/The Bash). | P0 |
| F7.3 | **Reliability score** (show-up rate, on-time rate, cancellation history) displayed as a badge, factored into feed ranking. | P1 |
| F7.4 | Dispute resolution: structured flow (no-show, gross misrepresentation, partial performance) with ops adjudication SLA of 5 business days; payout held meanwhile. | P0 (basic), P1 (full tooling) |

### F8. Promotion & compliance helpers (venue retention features)

| # | Requirement | Priority |
|---|---|---|
| F8.1 | Every confirmed booking auto-generates a **public event page** (SEO: "live music at {venue} {date}") and a social-ready image asset. | P1 |
| F8.2 | Syndication: push confirmed events to Bandsintown (700K artists / 100M fans, open APIs) and Google Business Profile events. | P1 |
| F8.3 | **PRO licensing guidance** in venue onboarding: plain-English explainer of ASCAP/BMI/SESAC/GMR obligations (~$1,500+/yr typical for live music), with an "originals-only" slot toggle that documents reduced covers exposure. Positioning: guidance, not legal advice; venue attests to compliance in ToS. | P1 (static guidance P0 in onboarding) |
| F8.4 | Venue compliance checklist: entertainment permit reminder, noise-curfew field surfaced on every booking, COI collection per F1.7. | P1 |

### F9. Admin & ops (internal)

| # | Requirement | Priority |
|---|---|---|
| F9.1 | Ops dashboard: user/booking search, manual booking edits, refunds, payout holds, account suspension. | P0 |
| F9.2 | Liquidity dashboard: slots posted/filled, time-to-fill, application depth per slot, supply/demand balance by format and neighborhood. | P0 |
| F9.3 | Content moderation queue (profiles, media, reviews) + dispute queue. | P0 |

---

## 7. Non-functional requirements

- **Mobile-first responsive web app** at launch (performers live on phones; venue managers on tablets/laptops). Native apps P2; push via PWA + SMS until then.
- Payments: PCI scope minimized via Stripe Elements/Connect; no card data touches our servers.
- Trust & safety: real-name policy for venue accounts; rate-limited messaging; no off-platform payment solicitation in messages (detection-flagging, not auto-ban — see Risks).
- Availability target 99.9%; gig-day flows (runsheet, contacts, payment confirmation) must degrade gracefully offline (cached runsheet).
- Privacy: contact info gated until confirmation; performer addresses never shown; CCPA-grade data handling.
- Accessibility: WCAG 2.1 AA.

## 8. Risks & mitigations

| Risk | Why it's real (see research doc) | Mitigation |
|---|---|---|
| **Disintermediation/leakage** — venue and band meet on Gigit, then book residencies off-platform | The defining failure mode of recurring local-services marketplaces (a16z, Hagiu & Wright); residencies are exactly our use case | Low flat venue fee (cheap to stay); payment protection + contracts + replacement engine only apply on-platform (The Bash precedent); recurring-series tooling makes the *series* easier to manage on-platform than off; long-term: venue subscription converts the relationship to SaaS where leakage stops mattering |
| **Chicken-and-egg in launch metro** | GigTown subsidized both sides with $2M and never compounded | Single metro; seed supply first (performers/techs join free, import profiles in <10 min); recruit existing scene producers (Don't Tell model); founder-led venue sales to 20–30 anchor venues with recurring series before public launch |
| **GigFinesse moves down-market / GigPig enters US** | Both funded and active | Speed in one metro + the two flanks they don't cover (sound techs, comedy-first); self-serve DNA vs GigFinesse's concierge ops |
| **Quality control at open-marketplace scale** | Venues can't assess talent; one bad night burns a venue | Media-required profiles, reviews only from real bookings, reliability scores, "first gig" badge with money-back guarantee for the venue's first booking |
| **Worker classification / labor law** | Sofar's $460K NYS DOL settlement | Gigit is a true marketplace: performers set rates, accept/decline freely, work for many venues; we never direct the performance; no volunteer labor anywhere in ops; counsel review pre-launch |
| **Payment regulation / tax** | 1099-K state patchwork | Stripe Connect handles KYC/1099 generation; W-9 at onboarding before first payout |
| **Low transaction values strain unit economics** | $150 coffee-shop gig × low/no fee must cover CAC + support | AI-leveraged cost base: AI-assisted venue outreach and onboarding (personalized at near-zero marginal cost), AI-first support (target <1 human touch per 20 bookings), and small-team AI-accelerated engineering. Recurring series = one acquisition, 50 bookings/yr. Monetization triggers (§4) flip on per-metro once liquidity is proven |
| **Free-period revenue gap** | No venue fees until momentum triggers fire | Processing margin from day one; burn stays low because the cost base is AI-leveraged, not headcount-leveraged; triggers are metric-based so the free period self-terminates exactly when the product has earned pricing power |

## 9. Success metrics

**North star: filled recurring slots per week in the launch metro.**

Liquidity (the only thing that matters pre-scale):
- Slot fill rate ≥70%; median time-to-fill <72h; ≥3 applications per slot median
- Performer: % of active performers with ≥1 booking/month ≥40% (anti-Sonicbids metric — the incumbents' fatal stat was huge registration, near-zero per-artist bookings)
- Tech attach rate: % of "tech needed" bookings filled on-platform ≥50%

Retention ("Happy GMV"):
- Venue 90-day retention (≥1 booking in each of 3 consecutive months) ≥60%
- Rebooking rate (same venue books same performer again) — tracked as a health signal, not suppressed
- Cancellation rate <8% of confirmed bookings; no-show rate <1%

Business:
- GMV, net revenue, venue subscription conversion (post-introduction)
- NPS by side; dispute rate <2% of bookings

## 10. Launch plan (phased)

**Phase 0 — Supply seeding (pre-launch, ~8 weeks):** pick metro (criteria: dense brewery/coffee scene, active open-mic circuit, no GigFinesse presence; candidates to be validated with primary research — note the biggest market-sizing unknown is % of venues hosting live entertainment, so run a 50-venue survey in the candidate metros). Onboard 150+ performers, 20+ techs via scene partnerships; hand-sign 25 anchor venues with committed recurring series. Outreach is AI-leveraged: personalized venue prospecting (scrape metro venue lists + event calendars, draft individualized pitches citing the venue's actual programming), performer onboarding from existing EPK/social links in <10 minutes, and AI-drafted local-scene content — founder time goes to the 25 anchor-venue relationships, not the long tail.

**Phase 1 — MVP launch (P0 scope):** slots, apply/invite, booking + auto-contract, Stripe payments with post-gig release, sound-plan + tech sub-slots, reviews, ops dashboards. **Venues free** (processing margin only) until the §4 momentum triggers fire.

**Phase 2 — Retention & differentiation (P1 scope):** replacement engine, lineup/producer tools, split payouts, promotion syndication, reliability scores, COI handling, house-tech relationships. Venue pricing introduced per-metro per the §4 triggers, with early-adopter grandfathering.

**Phase 3 — Scale (P2 + expansion):** second metro (playbook-ized), native apps, standalone tech bookings, ticketed-show support, ML matching.

## 11. Open questions

1. **Metro selection** — needs the 50-venue primary survey; research found no authoritative "% of venues hosting live entertainment" statistic anywhere.
2. **Post-momentum venue pricing point** — £15/gig works in the UK (GigPig), but our AI-leveraged cost base lets us undercut it; test ~$5–15/gig vs low subscription (~$19–49/mo) once the §4 triggers fire. Also decide: does the processing margin alone ever suffice as the permanent model?
3. **Comedy lineup payouts at MVP** — single payout to producer (simple, but producer becomes a payment intermediary) vs split payouts at P0 (more build)? Current call: single payout at MVP, splits in Phase 2 — revisit if comedy traction outpaces music.
4. **Should venues see each other's budgets?** (Market-rate transparency helps performers; venues may resist. Current call: show metro-level rate benchmarks, not individual venue history.)
5. **Guarantee design** — what exactly does Gigit pay/do on a performer no-show? (Refund fee + priority refill at MVP; "we cover the replacement premium" later?)
6. **Name/trademark check** — "Gigit" vs existing gig-economy marks; counsel review needed.

# Gigit — Product Requirements Document (v0.1)

**Status:** Draft for review
**Date:** June 2026
**Companion docs:** [`research/competitive-landscape.md`](research/competitive-landscape.md) — competitor research and sourcing for every market claim referenced here · [`research/ai-era-features.md`](research/ai-era-features.md) — analysis behind the F-AI requirements referenced below · [`research/metro-selection.md`](research/metro-selection.md) — launch metro shortlist.

---

## Mission

**There should be more live music in the world.** The rooms that could host it and the acts that could fill them mostly can't find each other — not for lack of demand, but for lack of any infrastructure between them. Gigit is that infrastructure. We don't take a cut of the music, and we're not built to maximize a take: we exist to get more nights booked in more rooms, and to charge as little as possible, for as long as possible, while staying alive to keep doing it. Every pricing decision below follows from that — not the other way around.

---

## 1. Problem statement

Small hospitality venues (restaurants, coffee shops, bars, breweries) want live entertainment because it drives traffic, but booking it is a fragmented, relationship-gated mess: finding acts means Instagram DMs, Craigslist, and word of mouth; assessing quality is guesswork; cancellations leave holes that get filled with "lower quality or ill-fitting acts"; and the surrounding logistics (contracts, payment, sound) are entirely manual.

Local bands, solo musicians, and stand-up comedians have the mirror problem: the venues that would host them are invisible, bookers are unresponsive, pay is opaque and negotiated from scratch every time, and getting paid is slow and informal.

Live sound techs — needed whenever a show's sound isn't already handled by a house PA-plus-engineer or a self-contained act — have no marketplace at all. Work is found through personal networks that take years to build and reset when you move cities.

**Gigit is a three-sided marketplace where venues post entertainment slots, performers (bands and comedians) book them, and sound techs (with or without PA rigs) attach to those bookings.** It starts as discovery and coordination — the gig feed, the booking handshake, the sound plan, reviews and reliability — and the venue and act settle up directly, the way they already do. Payments, e-signed contracts, and the monetary cancellation-fee schedule are designed in but deferred, switched on only when the scene needs them (see §4); cancellation *handling* — reopening the slot, notifying, a reliability strike — ships at launch.

### Why now / why this is winnable
- The profitable incumbents (GigSalad, The Bash) serve private-event planners, not recurring venue programming.
- The one funded US competitor (GigFinesse, ~$15M total funding) is concierge-style, opaque, music-only as of 2026, and has no sound-tech side.
- GigPig (UK) has proven the venue-pays self-serve model at 100,000+ gigs booked, and hasn't entered the US.
- Nobody integrates sound techs, and comedy booking for bars/breweries is still run by human producers.

## 2. Goals and non-goals

### Goals (12 months)
1. Achieve booking liquidity in **one launch metro**: ≥70% of posted slots filled, median time-to-fill <72 hours.
2. Make Gigit the lowest-friction way for a small venue to run a recurring entertainment program (weekly music night, monthly comedy night) end to end.
3. Make Gigit the place the local scene *meets and commits with confidence*: confirmed bookings, clear shared terms, real reviews, and reliability that cuts both ways — so a venue and an act find each other and lock the night without either chasing the other.
4. Onboard sound techs as bookable resources that **attach to the shows that actually need them** (§5) — the industry's first — so the rooms and acts that can't cover their own sound have somewhere to turn.

### Non-goals (v1)
- Ticketing and consumer-facing event discovery (syndicate to Bandsintown/Google instead; revisit in v2).
- Dedicated music venues with in-house talent buyers (Opendate/Prism territory).
- Private events (weddings/corporate) — GigSalad/The Bash territory; revisit as an expansion revenue lever later.
- National coverage. One metro until liquidity metrics are hit.
- Becoming the promoter (Sofar model). Gigit never owns the show, the door, or the audience relationship.
- Artist development features (EPK hosting beyond what booking requires, fan followings, streaming embeds beyond profile media).

### Anti-requirements (trust policy — deliberately never built)
Per the AI-era analysis (`research/ai-era-features.md` §7):
- **No AI-generated or AI-enhanced performer media.** We detect misrepresentation (F7.5); we never enable it.
- **No fully autonomous booking commitments.** AI agents draft, watch, and propose; a human confirms anything binding.
- **No algorithmic/dynamic setting of performer pay.** Recreates the Sofar opacity problem we position against.
- **No AI-composed background-music product for venues.** A different business that would existentially alienate the supply side.

## 3. Users and personas

| Persona | Profile | Core jobs-to-be-done |
|---|---|---|
| **Venue manager "Dana"** | Owns/manages a brewery taproom; no music background; books 4–8 events/month between other duties | Fill my Friday slot with something good for my room and budget; don't make me chase anyone; get the slot refilled fast if they cancel; tell me what licenses I need |
| **Band leader "Marcus"** | Fronts a 4-piece covers/originals band; day job; plays 2–6 gigs/month at $400–$800/band | Find venues that actually book acts like mine; stop negotiating from zero; settle up without the awkward chase; land repeat slots |
| **Solo performer "Priya"** | Acoustic singer-songwriter; coffee-shop circuit; $75–$150+tips/set | Low-stakes discovery; fill weekday slots; tips |
| **Comedian "Jess"** | 5 years in; hosts/features; produces a monthly bar show | Find rooms that want comedy; book lineups fast; sort the split with the other comics on the bill |
| **Sound tech "Sam"** | Freelance live engineer with a small PA rig in a van | Fill empty dates; stop depending on word of mouth; get paid without chasing; know exactly what the room/band needs before showing up |

Secondary: **comedy/music producer** (books lineups of multiple acts into a slot — power user of the comedian flow); **Gigit ops admin** (internal).

## 4. Business model

Mission-first (see above), and grounded in the competitive research (§7 and §11 of the research doc): every platform that taxed the supply side corroded the trust that made it valuable. So the model is the *smallest one that keeps the platform alive* — charge the side that profits from a filled room (the venue) a token amount, only once the platform is provably working, and never charge the people making the music. Full detail in [`docs/pricing.md`](docs/pricing.md).

1. **Free for performers and sound techs. Forever.** No fee to join, apply, message, or get booked. No pay-to-rank, no featured placement, no submission fees. The mission is to get artists *more* paid work — charging them works against it. (Sonicbids is the cautionary tale.)
2. **Gigit doesn't touch the gig money.** The venue pays the act directly — cash, Venmo, check, however they already do it. Gigit is the noticeboard and the handshake, not the bank. This is a deliberate **discovery-first** posture: payment processing, escrow/payouts, click-wrap contracts, and tax handling are designed (and the architecture keeps the seam ready — see [`docs/pricing.md`](docs/pricing.md)) but **switched off** until the scene actually needs them. Building the marketplace ≠ becoming its bank on day one.
3. **Venues pay a token fee — deferred until momentum.** Until Gigit is demonstrably filling a venue's calendar, it costs nothing. Then: **~$5/month** to run an entertainment program through Gigit, plus an optional **~$5 per booking** — less than one round of drinks, priced to keep the lights on, not to profit. Artists and techs never see either fee.
4. **Monetization triggers, not a timeline.** Venue pricing switches on per-metro only when the platform has earned it: fill rate ≥70% for 8 consecutive weeks, ≥100 bookings/month in metro, and venue 90-day retention ≥60%. Existing venues are grandfathered free for 12 months — joining early is never punished.
5. **Revenue is intentionally near-zero at launch — and that's the strategy.** We're not chasing day-one margin; we're chasing liquidity, the only genuinely hard thing. An AI-leveraged cost base (AI-assisted outreach, onboarding, and first-line support; a 1–3 person team) makes "free" survivable for a long time. Cheap-forever pricing is also the anti-disintermediation strategy: at $5 it isn't worth leaving to dodge the fee.
6. **Pay transparency is policy:** every slot shows its budget; everyone on a booking sees the same number. We never set or algorithmically adjust anyone's pay. (Sofar's opaque-spread model produced lasting damage; transparency is our wedge and a trust moat — and it survives intact whether or not we ever process the money.)

## 5. The marketplace model

**An asymmetric three-sided market.** A show needs two sides to exist at all — a **venue** with a room and a **performer** to fill it. That is the mandatory core, and it is where liquidity is won or lost. The **sound tech is a conditional third side**: most shows never need one. Sound is already handled when the room has a house PA and someone to run it, or when the act is self-contained (brings its own PA, runs its own sound). A tech is summoned only for the shows where neither is true. So tech supply is *derived demand* — an attach to the subset of bookings the sound plan (F6.1) flags as uncovered — not a third pool we must fill for every gig. Practically: seed only enough techs to cover the uncovered fraction in-metro, and measure the tech side by **attach rate on tech-needed bookings**, never by raw tech count.

- **Demand posts, supply applies — plus direct invite.** Venues post **slots** (date, time, duration, genre/format, budget, room details). Performers apply with one tap (profile = application — no essays). Venues can also browse/search performers and invite them to a slot. This is the GigPig/Open Comedy interaction model, chosen over GigSalad's reverse-auction quoting (which produces race-to-the-bottom dynamics performers hate) and over GigFinesse's concierge matching (which doesn't self-serve scale).
- **Sound techs attach to the bookings that need them** (see F6): when a booking's sound plan shows a gap the venue and act can't cover themselves, it generates a tech sub-slot either party can fund. Shows whose sound is already covered never see one — the tech side is invisible until it's needed.
- **Recurring slots are first-class** (weekly music night, monthly comedy night) — recurrence is the core venue habit: the **series, not the one-off gig, is the unit of venue value** (and, eventually, of venue pricing), so the product treats the series as the primary object.

---

## 6. Functional requirements

Priorities: **P0** = MVP launch blocker; **P1** = fast-follow (first 1–2 quarters post-launch); **P2** = later; **D** = **deferred** — designed and seam-ready, but switched off for the discovery-first launch (Gigit touches no gig money); turns on with venue monetization (see [`docs/pricing.md`](docs/pricing.md)).

### F1. Accounts, profiles, verification

| # | Requirement | Priority |
|---|---|---|
| F1.1 | Three account types — **Performer** (subtype: band / solo musician / comedian / other), **Venue**, **Sound tech**. One human can hold multiple roles (a comedian who produces; a musician who does sound) under one login. | P0 |
| F1.2 | **Performer profile** = lightweight EPK: name, genre/format tags, home metro + travel radius, written bio, **photos and audio tracks uploaded natively; video via YouTube/Vimeo embeds**, set lengths offered, standard rate range, typical stage/tech needs (input count, vocal-PA-only vs full backline, stage plot upload optional). | P0 |
| F1.3 | **Venue profile**: type (bar/restaurant/coffee shop/brewery/other), capacity, room photos, stage/performance area dimensions, **house PA & gear inventory** (structured checklist: PA yes/no, mixer channels, mics, monitors, who runs sound), typical audience, parking/load-in notes, hospitality offered (meal/drinks tab), noise constraints/curfew. | P0 |
| F1.4 | **Sound tech profile**: experience summary, gear offered (none / partial / full PA rig with specs: speakers, mixer, mic package, monitors), rates (labor-only vs with-rig), travel radius, credits/references. | P0 |
| F1.5 | Identity verification (email + phone) at signup. (Stripe identity verification before first payout is deferred with payments.) | P0 |
| F1.6 | Badges earned from platform behavior: gigs completed, on-time rate, response rate. No pay-to-rank placement, ever. | P1 |
| F1.7 | COI (certificate of insurance) upload on performer/tech profiles; venues can require COI per slot; expiry tracking. | P1 |
| F1.8 | **Link-in onboarding (F-AI.7):** performer/tech pastes one URL (Instagram/Bandcamp/YouTube/Linktree) → AI drafts the complete profile (bio, genre tags, media embeds, set lengths, inferred tech needs) for review. Target: bookable profile in <5 minutes from one link. AI drafts, human approves — nothing publishes unconfirmed. | P0 |

### F2. Slot posting & discovery

| # | Requirement | Priority |
|---|---|---|
| F2.1 | Venue posts a **slot**: date(s), start time + duration, entertainment type (live music / comedy / either), genre/format preferences, budget (required — pay transparency is policy), what's provided (PA, meal, drinks, parking), audience expectations. Posting flow ≤3 minutes. | P0 |
| F2.2 | **Recurring slot series** (e.g., every Friday; first Tuesday monthly) with per-occurrence overrides. | P0 |
| F2.3 | Performer-facing **gig feed**: filter by date, distance, pay, format; saved-search alerts (push/email) for matching new slots. | P0 |
| F2.4 | Venue-facing **performer search**: filter by format/genre, availability, rate range, distance; invite-to-slot action. | P0 |
| F2.5 | One-tap **apply** (profile is the application; optional short note). Venue sees applicant list with profiles, media, badges, and reviews inline. | P0 |
| F2.6 | Comedy **lineup support**: a slot can request multiple acts (host + feature + headliner with per-act pay), and a producer-role performer can apply with a packaged lineup. | P1 (single-act comedy slots are P0) |
| F2.7 | Matching/ranking algorithm v1 = filters + recency + reliability score. ML recommendation later; long-term, ranking trains on business outcomes from F8.5. | P0 (v1), P2 (ML) |
| F2.8 | **Natural-language/SMS slot posting (F-AI.2):** venue texts or types a plain-English request ("something chill for Sunday brunch, $200ish") → parsed into a structured slot using venue-profile defaults → confirmed before publishing. SMS is a first-class posting surface — venue managers live in texts, not apps. | P0 |

### F3. Booking flow & contracts

| # | Requirement | Priority |
|---|---|---|
| F3.1 | Venue selects an applicant → **offer** with locked terms (date, time, set length, pay, what's provided) → performer accepts → booking confirmed. Any term change re-requires both-party confirmation. | P0 |
| F3.2 | On confirmation both sides get a plain-language **terms summary** (parties, date/time, set length, pay, what's provided, cancellation expectations) — the shared record of the deal, shown in-app and in the confirmation notification. The formal click-wrap / e-signed **performance agreement** is **deferred** until payments turn on; until then the booking record is the receipt. | P0 (terms summary), D (e-sign) |
| F3.3 | **Cancellation handling.** Performer cancels → slot auto-reposted with priority + reliability hit; repeated late cancels → suspension. Venue cancels → noted on the venue's reliability, act notified, slot reopened. The **monetary cancellation policy** (industry-norm fee schedule: >14d none / 48h–14d 50% / <48h 100% to performer) is **deferred** with payments — it needs money movement to mean anything. | P0 (reliability + repost), D (fees) |
| F3.4 | **Replacement engine:** on any cancellation, the slot is instantly re-broadcast to matched, available performers as an urgent fill (the venue's worst pain point per research). | P1 |
| F3.5 | Day-of-show runsheet auto-shared with all parties: load-in time, contact phones, set times, gear summary, payment status. | P1 |
| F3.6 | Calendar: per-user availability calendar; confirmed bookings sync out via iCal/Google Calendar. | P0 (in-app + iCal out), P1 (two-way sync) |

### F4. Payments — **deferred** (the whole section)

**Discovery-first launch processes no gig money** — the venue pays the act directly, the way they already do (see [`docs/pricing.md`](docs/pricing.md)). The architecture keeps the Stripe seam ready and the booking state machine is built for these flows; they are listed here so the design stays whole and turn on together when venue monetization does. The only money Gigit ever touches is its own venue fees, billed via Stripe Billing (not Connect).

| # | Requirement | Priority |
|---|---|---|
| F4.1 | **Stripe Connect** (separate charges & transfers + manual payouts — Stripe offers no true escrow; this is the standard marketplace pattern). Venue's card/ACH charged at confirmation; funds held in platform balance; **auto-released to performer/tech 24h after gig end** unless a dispute is opened. | D |
| F4.2 | Performer marks "gig played" / venue non-action auto-confirms at +24h; dispute window pauses release. | D |
| F4.3 | **Band split payouts:** band accounts can define member splits; one booking → N payouts. Same mechanism covers comedy lineup splits to multiple comedians. | D (single payout to the booking owner when payments first turn on; splits later) |
| F4.4 | Tax compliance: W-9/TIN collection via Stripe at onboarding; 1099-K issuance at federal thresholds (>$20K and >200 txns post-OBBBA) **and** lower state thresholds (MA/MD/NJ etc.). | D |
| F4.5 | Instant payout option (small fee) vs free standard payout. | D / P2 |
| F4.6 | Tip jar: QR code on the day-of runsheet → direct tips to the performer (Gigit takes nothing on tips). | D / P2 |

### F5. Messaging & notifications

| # | Requirement | Priority |
|---|---|---|
| F5.1 | In-platform messaging scoped to applications, bookings, and **direct venue→performer inquiries** (a venue can message any performer, typically with an invite attached; rate-capped, performer can mute/block; performer→venue cold messaging stays off to protect bookers from pitch spam); full contact details revealed at confirmation (phone numbers needed day-of). | P0 |
| F5.2 | Push + email + SMS for the critical path: new matching slot, application received, offer, confirmation, day-before reminder (and payment released, once payments are on). Venue managers live in their POS, not our app — SMS matters. | P0 |
| F5.3 | Response-time tracking surfaced on profiles ("usually responds in X hours") — unresponsive bookers are a top performer complaint. | P1 |

### F6. Sound tech integration (the differentiator)

Sound is the **conditional third side** (§5): these requirements engage only for bookings the sound plan flags as uncovered — most shows never trigger them, and the tech surface stays invisible until one does.

| # | Requirement | Priority |
|---|---|---|
| F6.1 | At slot creation, the system computes a **sound plan** from structured data: venue's house PA inventory × performer's tech needs → "covered" / "tech needed" / "tech + rig needed". | P0 |
| F6.2 | If sound is needed, either party can add a **tech sub-slot** to the booking with its own budget; payer is explicit (venue or performer; venue-pays encouraged by default UX). Techs discover and apply to tech sub-slots exactly like performers apply to slots (same feed, same one-tap apply, same reviews; same payment rails if/when payments turn on). | P0 |
| F6.3 | Tech sub-slot inherits gig context automatically: room specs, input list from the performer's profile, set times — "know exactly what I'm walking into" is the tech's core unmet need. | P0 |
| F6.4 | Standing venue↔tech relationships: a venue can designate a house tech who auto-attaches to its bookings. | P1 |
| F6.5 | Standalone tech bookings (band hires a tech for an off-platform gig; venue hires a tech to install/tune a house PA) — keeps tech-side liquidity healthy independent of slot volume. | P2 |
| F6.6 | **Photo-to-specs ingestion (F-AI.11):** venue photographs their PA/gear closet and room, tech photographs their rig → multimodal extraction drafts the structured inventory (mixer channels, speakers, mics) for a confirmation tap. This is the data capture that makes F6.1 feasible at scale — uncapturable gear data is plausibly why no sound-tech marketplace has ever existed. | P0 |

### F7. Reviews & trust

| # | Requirement | Priority |
|---|---|---|
| F7.1 | Double-blind post-gig reviews (each side reviews; published simultaneously or at +7 days). Venue→performer: draw/professionalism/quality. Performer→venue: hospitality, accuracy of listing, and whether they paid as agreed. Tech reviewed by both. | P0 |
| F7.2 | Reviews only from completed platform bookings — no drive-by reviews (a top performer complaint about GigSalad/The Bash). | P0 |
| F7.3 | **Reliability score** (show-up rate, on-time rate, cancellation history) displayed as a badge, factored into feed ranking. | P1 |
| F7.4 | Dispute resolution: structured flow (no-show, gross misrepresentation, partial performance) with ops adjudication SLA of 5 business days; **reviews held meanwhile** (and payout held too, once payments are on). At launch the lever is reputational — reliability strikes, review holds, suspension — not monetary. Evidence packs auto-assembled from the booking record with drafted adjudications for human sign-off (F-AI.13). | P0 (basic), P1 (full tooling) |
| F7.5 | **Synthetic-act and media-fraud detection (F-AI.8):** screen profile media at upload for AI-generated performances, stolen/stock footage, and misrepresentation; flagged profiles held for review. A fraud class prior platforms never faced — table stakes for venue trust. | P0 |

### F8. Promotion & compliance helpers (venue retention features)

| # | Requirement | Priority |
|---|---|---|
| F8.1 | Every confirmed booking auto-generates a **public event page** (SEO: "live music at {venue} {date}") and a social-ready image asset. | P1 |
| F8.2 | Syndication: push confirmed events to Bandsintown (700K artists / 100M fans, open APIs) and Google Business Profile events. | P1 |
| F8.3 | **PRO licensing guidance** in venue onboarding: plain-English explainer of ASCAP/BMI/SESAC/GMR obligations (~$1,500+/yr typical for live music), with an "originals-only" slot toggle that documents reduced covers exposure. Positioning: guidance, not legal advice; venue attests to compliance in ToS. | P1 (static guidance P0 in onboarding) |
| F8.4 | Venue compliance checklist: entertainment permit reminder, noise-curfew field surfaced on every booking, COI collection per F1.7. | P1 |
| F8.5 | **POS-integrated ROI loop (F-AI.1) — Phase 2 flagship.** Venue connects Toast/Square/Clover → every booking gets a revenue-lift receipt vs. matched baseline nights ("this act lifted your Friday net +$640 / 22%"). Converts live entertainment from a faith-based expense into a measurable channel; gives performers the industry's first provable "draw" credential; trains matching on business outcomes. **Baseline data accrual (gig-night vs. non-gig-night patterns) begins at MVP**, before the integration ships. | P1 (flagship); baseline accrual P0 |

### F9. Admin & ops (internal)

| # | Requirement | Priority |
|---|---|---|
| F9.1 | Ops dashboard: user/booking search, manual booking edits, account suspension (refunds and payout holds when payments are on). | P0 |
| F9.2 | Liquidity dashboard: slots posted/filled, time-to-fill, application depth per slot, supply/demand balance by format and neighborhood. | P0 |
| F9.3 | Content moderation queue (profiles, media, reviews) + dispute queue. | P0 |
| F9.4 | **AI-first support (F-AI.13):** conversational first-line support across all three sides with human escalation. This is what makes the <1 human touch per 20 bookings target — and therefore $150-gig unit economics — writable at all. | P0 |

---

## 7. Non-functional requirements

- **Mobile-first responsive web app** at launch (performers live on phones; venue managers on tablets/laptops). Native apps P2; push via PWA + SMS until then.
- Payments (deferred — see [`docs/pricing.md`](docs/pricing.md)): Gigit processes no gig money at launch. The only money it touches is its own venue fees, via Stripe Billing. When the gig-payments rail turns on, PCI scope is minimized via Stripe Elements/Connect; no card data touches our servers.
- Infrastructure: simple AWS-native deployment (App Runner web service, one small EC2 worker, RDS Postgres, S3 + CloudFront for photos/audio; video via YouTube/Vimeo embeds) — see [`docs/engineering-spec.md`](docs/engineering-spec.md).
- Trust & safety: real-name policy for venue accounts; rate-limited messaging; anti-leakage flagging of attempts to take future booking *relationships* off-platform (detection-flagging, not auto-ban — see Risks). Paying for the gig directly is expected — that's the model — so the concern is circumventing Gigit for *booking*, not for payment.
- Availability target 99.9%; gig-day flows (runsheet, contacts) must degrade gracefully offline (cached runsheet).
- Privacy: contact info gated until confirmation; performer addresses never shown; CCPA-grade data handling.
- Accessibility: WCAG 2.1 AA.

## 8. Risks & mitigations

| Risk | Why it's real (see research doc) | Mitigation |
|---|---|---|
| **Disintermediation/leakage** — venue and band meet on Gigit, then book residencies off-platform | The defining failure mode of recurring local-services marketplaces (a16z, Hagiu & Wright); residencies are exactly our use case — and discovery-first makes it *worse* than a payments platform would face, because we hold no money in the middle | Honest trade, accepted deliberately ([`docs/pricing.md`](docs/pricing.md) §3): cheap by design (at ~$5 it isn't worth leaving to dodge a fee); the value that compounds is *discovery itself* — the next open slot, the next new act, reviews and reliability you only accrue by staying; recurring-series tooling makes the series easier to run on-platform than off. We accept higher leakage in exchange for a far lower cost base and faster liquidity. The payments/protection lever (contracts, replacement guarantee, dispute money, "guarantee only covers in-system" — The Bash precedent) is held in reserve and switches on as an anti-leakage tool if/when monetization does. |
| **Chicken-and-egg in launch metro** | GigTown subsidized both sides with $2M and never compounded | Single metro; seed supply first (performers/techs join free, import profiles in <10 min); recruit existing scene producers (Don't Tell model); founder-led venue sales to 20–30 anchor venues with recurring series before public launch |
| **GigFinesse moves down-market / GigPig enters US** | Both funded and active | Speed in one metro + the two flanks they don't cover (sound techs, comedy-first); self-serve DNA vs GigFinesse's concierge ops |
| **Quality control at open-marketplace scale** | Venues can't assess talent; one bad night burns a venue | Media-required profiles, reviews only from real bookings, reliability scores, a "first gig" badge plus a concierge backstop on a venue's first booking (priority refill + hands-on support if an act falls through) — a monetary first-booking guarantee returns with payments |
| **Worker classification / labor law** | Sofar's $460K NYS DOL settlement | Gigit is a true marketplace: performers set rates, accept/decline freely, work for many venues; we never direct the performance; no volunteer labor anywhere in ops; counsel review pre-launch |
| **Payment regulation / tax** | 1099-K state patchwork | *Reduced to near-zero at launch* — discovery-first processes no gig money, so no escrow, money-transmission, KYC, or 1099 surface at all. When the payments rail turns on, Stripe Connect handles KYC/1099 generation; W-9 at onboarding before first payout |
| **Discovery-first captures less / leaks more than the payments moat** | We deliberately defer the workflow moat the research recommends ("the workflow is the business") | Accepted trade, not an oversight: lower per-booking capture and higher leakage bought in exchange for a dramatically smaller build, lower ops + legal surface, and faster liquidity. The mission tolerates low capture (more music > max take); the payments seam stays ready to switch on without re-architecture ([`docs/pricing.md`](docs/pricing.md) §3–4) |
| **Low transaction values strain unit economics** | $150 coffee-shop gig × low/no fee must cover CAC + support | AI-leveraged cost base: AI-assisted venue outreach and onboarding (personalized at near-zero marginal cost), AI-first support (target <1 human touch per 20 bookings), and small-team AI-accelerated engineering. Recurring series = one acquisition, 50 bookings/yr. Monetization triggers (§4) flip on per-metro once liquidity is proven |
| **Free-period revenue gap** | Revenue is near-zero until the venue fee turns on | Accepted by design — liquidity, not early revenue, is the only thing that compounds. Burn stays low because the cost base is AI-leveraged, not headcount-leveraged, and discovery-first removes the entire payments build/ops; triggers are metric-based so pricing turns on exactly when the product has earned it |

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

**Phase 0 — Supply seeding (pre-launch, ~8 weeks):** metro selection per `research/metro-selection.md` — **Milwaukee primary, Pittsburgh second**; final call made by running the prospect-intelligence scrape (F-AI.14) in both metros to measure actual live-programming density (the "% of venues hosting live entertainment" stat that doesn't exist publicly — buildable ourselves from venue event calendars and social feeds, and the output doubles as the launch prospect list). Onboard 150+ performers and hand-sign 25 anchor venues with committed recurring series — the mandatory two sides (§5) where liquidity lives; seed just 20+ techs via scene partnerships, sized to the uncovered-sound fraction rather than 1:1 with performers. Outreach is AI-leveraged: personalized venue prospecting (scrape metro venue lists + event calendars, draft individualized pitches citing the venue's actual programming), performer onboarding from existing EPK/social links in <10 minutes, and AI-drafted local-scene content — founder time goes to the 25 anchor-venue relationships, not the long tail.

**Phase 1 — MVP launch (discovery-first P0 scope):** slots (incl. SMS/natural-language posting, F2.8), link-in onboarding (F1.8), apply/invite, the **booking handshake with a plain-terms summary** (F3.2), sound-plan + tech sub-slots with photo-to-specs capture (F6.6), reviews + media-fraud screening (F7.5), AI-first support (F9.4), ops dashboards, POS-baseline data accrual (F8.5). **Everyone free** — Gigit doesn't touch gig money; the venue and act settle directly. The gig-payments rail, e-signed contracts, and the monetary cancellation policy are **deferred** (see [`docs/pricing.md`](docs/pricing.md)).

**Phase 2 — Retention, monetization & differentiation (P1 + the deferred rail):** **flagship: the POS-integrated ROI loop (F8.5)** — every venue gets per-act revenue-lift receipts, built on baseline data accrued since MVP. The deferred **payments rail turns on alongside venue pricing** where the §4 triggers fire: Stripe (venue fee via Billing; optionally the gig-payment Connect flow with post-gig release), e-signed contracts, the monetary cancellation policy, split payouts. Plus: replacement engine, lineup/producer tools, auto-generated gig promotion (F-AI.4), reliability scores, COI handling, house-tech relationships. Early-adopter grandfathering applies.

**Phase 3 — Scale (P2 + expansion):** second metro (playbook-ized), native apps, standalone tech bookings, ticketed-show support, ML matching.

## 11. Open questions

1. **Metro selection** — needs the 50-venue primary survey; research found no authoritative "% of venues hosting live entertainment" statistic anywhere.
2. **Venue pricing point** — current call (see [`docs/pricing.md`](docs/pricing.md)): ~$5/month flat, optional ~$5/booking, far under GigPig's £15/gig. Open: does the flat $5/month alone suffice, or is the per-booking fee worth the billing complexity? And is a flat venue fee the *permanent* model, or does a value-add tier (ROI loop, promotion) ever justify more?
3. **Comedy lineup splits** — at the discovery-first launch Gigit moves no money, so a lineup's pay is split among the comics directly, off-platform (the producer or venue settles up). The single-payout-to-producer vs platform-split-payout question only arises when the payments rail turns on — current call then: single payout to the producer first, true split payouts later.
4. **Should venues see each other's budgets?** (Market-rate transparency helps performers; venues may resist. Current call: show metro-level rate benchmarks, not individual venue history.)
5. **Guarantee design** — what exactly does Gigit do on a performer no-show? At the discovery-first launch the lever is reputational + logistical (priority refill + reliability strike + suspension on repeats), since no money is held. A monetary guarantee ("we cover the replacement premium") is deferred with the payments rail.
6. **Name/trademark check** — "Gigit" vs existing gig-economy marks; counsel review needed.
7. **When — if ever — does the gig-payments rail turn on?** Discovery-first defers the whole money apparatus (Stripe Connect, escrow/payouts, contracts, the fee schedule). It returns only when venues actually want to pay acts through Gigit *and* the §4 triggers have fired — a demand signal per metro, not a date. Plausibly some metros never need it. Revisit at momentum; keep the seam warm.
8. **Tech-side seeding ratio** — given the asymmetry (§5), how many techs does a metro actually need? Sized to the *uncovered-sound fraction* of expected bookings, not to performer count — measure it from the sound-plan verdicts on early slots and seed against that, not a fixed ratio.

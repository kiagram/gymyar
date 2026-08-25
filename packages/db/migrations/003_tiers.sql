-- GymBuddy 003 — how many clients a subscription is for.
--
-- 002 sold one thing: coaching, unlimited, for a month or three or twelve. That prices a coach
-- with four clients the same as one with eighty, which means the second one is subsidised by
-- the first and neither is charged what the seat is worth to them. Tiers fix the shape.
--
-- Two columns rather than one, and the second is the one worth explaining.
--
-- `tier` is what they bought, and it is what the billing screen renders and what pricing looks
-- up. `client_cap` is what they were *promised*, copied onto the row at purchase time — the
-- same instinct as `payments.amount` storing exactly what was sent to the gateway rather than
-- a number recomputed later. If the studio tier is ever reshaped from 25 clients to 20, the
-- people who bought 25 keep 25, because their promise is on their row and not in a lookup
-- table that changed under them. Re-deriving the cap from the tier would take capacity away
-- from paying subscribers as a side effect of an unrelated pricing decision, silently.
--
-- Null `client_cap` means unlimited, and that is not a placeholder for "unset" — see `legacy`.

alter table subscriptions
  -- `plan` stays 'coach' and stays checked. It is the product line; this is the size within
  -- it. Collapsing the two would make "which product" and "how big" the same column, and they
  -- are not the same question.
  add column tier       text not null default 'legacy',
  add column client_cap int;

-- Everyone who already had a subscription bought unlimited coaching, so that is what they
-- keep. `legacy` is not on sale and cannot be purchased — it exists so that the enforcement
-- landing next cannot retroactively cap somebody who paid for no cap. A migration that quietly
-- takes away what was sold is a breach with a changelog entry, not a schema change.
--
-- The default above does the backfill for existing rows; it is restated here so that reading
-- this file tells you what happened to them without having to know that DDL defaults apply to
-- rows that already exist.
update subscriptions set tier = 'legacy', client_cap = null;

-- New rows are sold a real tier, so the default stops being useful the moment 004 is written.
-- It stays because a subscription row is also created by `ensureTrial`, which has no purchase
-- behind it and therefore nothing to name — a trialling coach is uncapped until they buy.
-- See domain/entitlement.js: TIERS.

alter table subscriptions
  add constraint subscriptions_tier_check
    check (tier in ('legacy', 'solo', 'studio', 'pro')),
  -- A cap of zero is a subscription that permits nothing, which is not a product. Null is the
  -- unlimited case and is allowed; zero and negatives are typos.
  add constraint subscriptions_client_cap_check
    check (client_cap is null or client_cap > 0);

-- What was actually sold, on the attempt itself.
--
-- `payments` is the record of what was asked for and what came back, and it has to stay
-- answerable a year later without joining to a subscription row that has since been renewed,
-- upgraded or downgraded. Without this column, "why was this person charged 349,000" has no
-- answer once their tier has moved on.
alter table payments
  add column tier text,
  -- What a Toman was worth when the money changed hands.
  --
  -- Filled by the work that follows this (see T1.3); nullable because every row written before
  -- that lands genuinely does not know, and inventing a rate for them would be worse than
  -- admitting the gap. Prices here are quoted in a currency that moved nine percent in the week
  -- this column was added, so revenue in Toman is not a number anyone can reason about after
  -- the fact — this is what makes the series comparable to itself.
  add column toman_per_usd numeric(12,2);

alter table payments
  add constraint payments_tier_check
    check (tier is null or tier in ('solo', 'studio', 'pro')),
  add constraint payments_toman_per_usd_check
    check (toman_per_usd is null or toman_per_usd > 0);

-- The cohort reads this: what people bought, and when. Cheap, and the alternative is a
-- sequential scan over every attempt ever made every time the admin screen loads.
create index payments_tier_idx on payments (tier, created_at desc) where tier is not null;

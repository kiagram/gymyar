-- GymYar 009 — what has already been said, so it is not said twice.
--
-- Everything the notifier sends is *scheduled* rather than caused: a check-in is due, a week has
-- gone quiet. Nobody pressed anything, so there is no request to hang the work on and no natural
-- once-ness to it. A timer in the API process fires it, and there may be two of those processes.
--
-- Which is the whole problem. The sweeper next door can run twice with no consequence — deleting
-- an object that is already gone is a no-op, and that is what makes it safe to scale out without
-- electing a leader. A notification has no such property. Sending it twice is two buzzes on
-- somebody's phone at six in the evening, and the second one is not a duplicate they can ignore:
-- it is the product looking broken.
--
-- ## The primary key is the guarantee
--
-- Not a check before sending — that is a read-then-write, and two containers can both read
-- "not sent" in the same millisecond. The claim *is* the insert:
--
--     insert into notifications_sent (...) on conflict do nothing returning *
--
-- A row back means this process won the right to send. Nothing back means somebody else already
-- has it, and the correct response is to do nothing at all. Same reasoning as the unique index
-- on `payments.ref_id` — an index cannot lose that race and a lookup can.
--
-- ## `fire_key` is what "once" means for this kind
--
-- It is chosen by whatever is sending, and it is the thing that must not happen twice:
--
--   checkin_due   the date the check-in is filed under, so once per week and not once per tick
--   coach_digest  today's date, so once a day
--
-- Writing it as text rather than a date is deliberate. Nothing here compares or sorts it — it is
-- an identity, and the next kind of reminder may key on something that is not a day at all.
--
-- ## It is a log of sends, not of notifications
--
-- A row here does not mean anybody read anything, or that a device was reached. `sendPush`
-- routinely reaches zero of them. It means this instance decided, once, that it was this
-- notification's turn — which is the only thing two processes need to agree on.

create table notifications_sent (
  user_id  uuid not null references users(id) on delete cascade,
  kind     text not null,
  fire_key text not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, kind, fire_key)
);

-- For the sweep that forgets old ones. Without it, "delete everything older than sixty days"
-- reads the whole table every fifteen minutes, forever.
create index notifications_sent_age_idx on notifications_sent (sent_at);

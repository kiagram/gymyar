-- GymYar 011 — the same code, sent down whichever channel is being proved.
--
-- 010 built one-time codes for phone numbers and named everything after them. A week later the
-- second channel arrived and wanted every property that file argues for: a code that is never
-- stored, a keyed hash rather than a plain one, five guesses, a resend cooldown, a daily
-- ceiling per destination, and a claim that rolls back when what it was for fails.
--
-- The choice was a second table with a second implementation of all of that, or one table with
-- a channel column. A second implementation is two places for an invariant to drift, and the
-- invariants here are the kind whose drift hands somebody an account. So: one table.
--
-- `phone` becomes `address` because it now holds two kinds of thing, and `channel` says which.
-- Nothing else about the row changes, and neither does anything the codes do.
--
-- ## `email_verified_at` has been a lie since 001
--
-- The column shipped in the first migration and nothing has ever written it, exactly as
-- `users.locale` shipped and was never written until two features turned out to need it. So
-- every address in this database is unverified, and anybody could always have signed up with
-- somebody else's — the endpoint checked that an address was well-formed and unclaimed, never
-- that the person typing it could read it.
--
-- ## Which is why existing rows are grandfathered, and new ones are not
--
-- The backfill below marks every *existing* address verified, and that is a claim this database
-- cannot actually support. It is still the right migration.
--
-- Password reset is about to require a verified address. Applying that rule retroactively would
-- take the only way back into an account away from every person already using this instance, to
-- defend against an exposure that has already happened: if somebody signed up with an address
-- that is not theirs, they hold that account today, and refusing them a reset does not take it
-- back. It only breaks the honest majority.
--
-- So the rule starts now. `created_at` rather than `now()` for the timestamp, so the row says
-- when the address arrived rather than pretending somebody proved something during a migration
-- — and an operator reading a suspiciously round number of verifications all dated before this
-- deploy can tell exactly what they are looking at.

alter table phone_codes rename to verification_codes;
-- The primary key keeps the old table's name through a rename, and a constraint called
-- `phone_codes_pkey` on a table called `verification_codes` is a small lie that outlives
-- everybody who remembers why.
alter index phone_codes_pkey rename to verification_codes_pkey;
alter table verification_codes rename constraint phone_codes_purpose_check
  to verification_codes_purpose_check;
alter table verification_codes rename column phone to address;

-- 'sms' or 'email'. Defaulted for the rows 010 left behind, which were all phone numbers, and
-- the default stays because a code with no channel is a code nobody can decide how to send.
alter table verification_codes add column channel text not null default 'sms'
  check (channel in ('sms', 'email'));

-- The lookup a verification does: this destination, on this channel, still live.
alter index phone_codes_live_idx rename to verification_codes_live_idx;
alter index phone_codes_expiry_idx rename to verification_codes_expiry_idx;
drop index verification_codes_live_idx;
create index verification_codes_live_idx on verification_codes (channel, address, created_at desc);

-- Grandfathered — see the header. Only addresses that already exist; nothing here verifies
-- anything, and no address added after this migration reaches the column without a code.
update users set email_verified_at = created_at
  where email is not null and email_verified_at is null;

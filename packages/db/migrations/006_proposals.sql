-- GymYar 006 — a proposal is not always a routine.
--
-- One rule holds this product together: **a coach never writes a client's rows.** A coach's
-- version of a programme lands in a side table and becomes the client's own row only when the
-- client accepts it, which is why there is exactly one writer per row and nothing to merge.
--
-- Everything arriving next needs that same rule and gets it wrong on its own. A macro target a
-- coach sets, a habit a coach assigns — both are a coach deciding something about a client, and
-- both are worthless if the coach can simply write it. Each one could grow its own
-- `nutrition_revisions`, `habit_revisions`, with its own supersede logic, its own accept path
-- and its own way of being subtly wrong about who may resolve what. Three tables that are the
-- same table is how "one writer per row" becomes a thing that is true in two places out of
-- three, and the third is the one nobody tested.
--
-- So the table stops being about routines.
--
-- ## The rename is the point, not decoration
--
-- `routine_revisions` holding a macro target is a schema that lies, and a schema that lies is
-- read by every person who arrives afterwards. The same goes for `routine_id` on a row whose
-- subject is a habit. Both are renamed here rather than left to drift, and the blast radius is
-- small on purpose: only `coaching.js` writes this table, and one client screen reads the
-- column.
--
-- ## What `kind` may be, and what can write one
--
-- All three values are listed now, though only 'routine' has a writer today. The constraint is
-- the list of what may be proposed, and a kind nothing can create is impossible rather than
-- permitted-and-broken — while adding the value later, in the migration that adds the feature,
-- would mean the feature ships as a schema change plus a code change instead of code alone.
--
-- `acceptProposal` refuses a kind it does not know how to apply. That is not defensive coding
-- for an impossible state: it is what stops a future insert with the wrong kind from being
-- accepted into the wrong table, which would put a nutrition target in somebody's routine list.

alter table routine_revisions rename to proposals;

-- Constraints and indexes keep the old table's name in theirs, and a violation reports the
-- constraint. "routine_revisions_status_check" on a habit proposal would send whoever is
-- reading the log looking for a table that no longer exists.
alter table proposals rename constraint routine_revisions_pkey to proposals_pkey;
alter table proposals rename constraint routine_revisions_status_check to proposals_status_check;
alter table proposals rename constraint routine_revisions_user_id_fkey to proposals_user_id_fkey;
alter table proposals rename constraint routine_revisions_link_id_fkey to proposals_link_id_fkey;
alter table proposals rename constraint routine_revisions_proposed_by_fkey to proposals_proposed_by_fkey;
alter index revisions_user_idx rename to proposals_user_idx;

-- The subject is whatever this kind of proposal is *about*, and only the kind knows what that
-- means: a routine id for 'routine', the habit's id for 'habit', and for 'nutrition' a constant,
-- because a client has one set of targets and there is nothing else to name.
alter table proposals rename column routine_id to subject_id;

-- The default is here to backfill the rows that already exist — every one of them is a routine,
-- because until this migration nothing else could be proposed — and then it goes. Leaving it
-- would mean a nutrition writer that forgot to name its kind silently creates a *routine*
-- proposal, and the way you would find out is a client accepting a macro target into their
-- programme list.
alter table proposals add column kind text not null default 'routine';
alter table proposals alter column kind drop default;

alter table proposals
  add constraint proposals_kind_check check (kind in ('routine', 'nutrition', 'habit'));

-- One open proposal per subject: a client answers their coach's current thinking, not a queue.
--
-- The old index keyed that on `routine_id` alone, which was only ever correct by luck. Routine
-- ids are generated client-side from a timestamp and five random characters, so they are unique
-- across accounts in practice and not by construction — two clients with the same id would have
-- found one of them unable to receive a proposal, with a unique-violation as the explanation.
--
-- A kind whose subject is a constant turns that luck into a certainty: with 'nutrition' naming
-- its subject the same way for everybody, one client with open targets would block the entire
-- instance. So the key is the client, the kind, and the subject — which is what "one open
-- proposal per subject" meant all along.
drop index revisions_one_open_idx;
create unique index proposals_one_open_idx
  on proposals (user_id, kind, subject_id) where status = 'pending';

-- GymYar 016 — the retrieval corpus: published literature, with its provenance attached.
--
-- What this is for is in docs/AI_TIERS.md §A3. The short version: the premium tier answers from
-- open-access papers rather than from a model's memory, and every claim it surfaces has to be
-- traceable back to something a person can open and check.
--
-- ## This is not anybody's rows
--
-- Every other table with content in it belongs to a user, carries `updated_at`/`deleted_at`, and
-- goes through `log_change()`. This one does none of that and is deliberately absent from
-- `TABLES` in sync.js. It is instance-wide reference data — the same papers for everybody — so
-- there is no owner to scope it to, nothing to merge, and nothing a phone needs offline. A
-- synced corpus would also mean shipping a few hundred megabytes of somebody else's text to
-- every device, which is the opposite of what the licence rules below are trying to achieve.
--
-- ## The provenance columns are the point, not decoration
--
-- `licence` and `url` are `not null` with non-empty checks, which makes "nothing in the corpus
-- lacks a licence somebody wrote down" a constraint rather than a convention. The rules in
-- docs/AI_TIERS.md are only worth anything if they cannot be forgotten by an ingestion script
-- somebody writes in a hurry at midnight, and a check constraint is the one place a rule cannot
-- be forgotten. `source_id` is the document a chunk came from, so withdrawing a source is one
-- delete rather than a rebuild — which is the whole reason retrieval is a safer answer here than
-- fine-tuning, and it is worthless unless the column exists.
--
-- ## Why the dimension is fixed, and the model is recorded
--
-- Embeddings from two different models are not comparable — the numbers are in different spaces,
-- and cosine between them is noise that looks like a result. So the store is specific to one
-- model: the column is `vector(768)` because that is what nomic-embed-text emits, and every row
-- records the model that produced it so a mismatch can be *detected* rather than silently
-- served. Changing the embedding model means re-ingesting, and that is a property of the idea
-- rather than of this schema.
--
-- ## Conditional, on purpose
--
-- pgvector is an extension, and `postgres:16-alpine` — what every instance built before this
-- migration is running — does not have it. A migration that hard-required it would refuse to
-- apply on those, which is a broken upgrade for a feature nobody has asked for yet. So this
-- creates the table where it can and says so where it cannot, and `corpus.js` reports the
-- feature absent rather than broken. That is the same shape as the vision model: with nothing
-- configured it is missing, not degraded.
--
-- If an instance later moves to an image that has pgvector, this migration has already been
-- recorded as applied and will not run again. `ensureCorpus()` in corpus.js closes that trap —
-- the ingestion script calls it, and it creates what this block skipped.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'vector') then
    raise notice 'pgvector is not available: the retrieval corpus is not created and the feature will report itself off. See docs/AI_TIERS.md.';
    return;
  end if;

  create extension if not exists vector;

  -- `execute` rather than plain DDL: the type `vector` does not exist until the statement above
  -- has run, and deferring the parse is what stops this block failing on its own first line.
  execute $ddl$
    create table corpus_chunks (
      id            uuid primary key default gen_random_uuid(),

      -- The document this came from, and where in it. Stable across re-ingestion, which is what
      -- makes ingestion idempotent and what makes withdrawing a source a single delete.
      source_id     text not null check (length(source_id) > 0),
      chunk_index   int  not null check (chunk_index >= 0),
      text          text not null check (length(text) > 0),

      -- What was embedded, and by what. See the header: a corpus holding two models' vectors is
      -- a corpus that returns nonsense with total confidence.
      embedding     vector(768) not null,
      embed_model   text not null check (length(embed_model) > 0),

      -- Provenance. Not nullable, because a passage nobody can attribute is a passage this
      -- product must not put in front of a coach.
      title         text not null check (length(title) > 0),
      url           text not null check (url ~ '^https?://'),
      licence       text not null check (length(licence) > 0),
      author        text,

      -- Quality, for ranking. Nullable because "we do not know" is a real answer and pretending
      -- otherwise would be the confident-wrong-citation failure this whole design is avoiding;
      -- `rank()` in corpus.js treats unknown as middling rather than as good.
      design        text check (design is null or design in (
                      'meta-analysis', 'systematic-review', 'rct', 'crossover',
                      'quasi-experimental', 'cohort', 'cross-sectional', 'case-study',
                      'narrative-review', 'other')),
      sample_size   int check (sample_size is null or sample_size > 0),
      peer_reviewed boolean not null default false,
      published_on  date,

      ingested_at   timestamptz not null default now(),

      unique (source_id, chunk_index)
    )
  $ddl$;

  -- Withdrawing a source, and counting what is held. Both are administrative rather than
  -- per-request, and both scan by source without this.
  execute 'create index corpus_chunks_source_idx on corpus_chunks (source_id)';

  /* HNSW rather than IVFFlat: it does not need to be built against a populated table to be any
   * good, and this table starts empty on every instance. Cosine, because that is what the
   * embedding model's vectors are normalised for and what `search()` orders by. */
  execute 'create index corpus_chunks_embedding_idx on corpus_chunks using hnsw (embedding vector_cosine_ops)';
end $$;

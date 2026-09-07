# Two AI tiers, and the corpus underneath the paid one

Part plan, part record. A1, A2 and A3 are built; A4 is not. Two parts of A3 have never met the
real thing — no Ollama has embedded anything and no corpus has been ingested — and §A3 says
exactly which, because a document that reads as finished work when it is verified logic is the
more expensive kind of wrong.

Laid out the way [WEARABLES.md](WEARABLES.md) was before any of that existed: the constraints
first, then the shape that survives them, then milestones somebody can cost — with the built ones
marked, and what building them taught written into them.

The ask it answers: a free tier that runs on the deployment's own Ollama, and a paid tier with
several thousand articles and books of field knowledge behind it.

## The constraints, stated plainly

Three, and they are the whole design. Everything below follows from them.

**1. A client is never gated.** This is not a preference, it is a promise made in three places:
`README.md` §"What is paid for, and what never is", the pricing section of the public site
(`apps/site/en/index.html`), and the shape of the entitlement system itself, whose four
capabilities are all coach-side verbs:

```js
// packages/domain/src/entitlement.js
const ALL = { readRoster: true, message: true, propose: true, takeClients: true }
```

Now look at where the AI actually lives (`apps/api/src/routes/ai.js`). Of five routes, three
are things a *client* does for themselves:

| Route | Whose feature | Gated on |
|---|---|---|
| `POST /api/ai/programme` | client | a session |
| `GET /api/ai/review` | client | a session |
| `POST /api/ai/parse-log` | client | a session |
| `POST /api/coach/clients/:id/ai-review` | coach | a session and the `workouts` scope |
| `POST /api/ai/form-check/:id` | either | a session and `mayRead` |

So "premium AI" cannot mean "AI for people who pay" without breaking the promise. Programme
generation and logging by typing are client features. **Only the coach-side model quality may
follow the subscription.**

**2. Hosted inference may not be reachable.** A paid tier backed by OpenAI, Anthropic or
DeepSeek means an Iranian operator holding an API account and paying its bill, which is
question 17 in [LEGAL_BRIEF.md](LEGAL_BRIEF.md) and is unresolved. Any design whose paid tier
*requires* a hosted model is a design that might not be operable at all. The one below does
not require it.

**3. The domain owns every number.** `planner.js` computes sets, reps, loads, progression and
exercise selection; a model writes language and nothing else, and every model output crosses a
validation boundary before it can affect anything (`normaliseBrief`, and the deterministic
parser for logs). A literature layer that speaks about volume or intensity walks straight into
the failure this split exists to prevent: the review and the app disagreeing about the same
lifter, which `ARCHITECTURE.md` §"Reviewing training" says explicitly must never happen.

Retrieval makes this *easier* to hold than fine-tuning would have. Retrieved text is a visible
input rather than something baked into weights, so "the literature never touches a number"
stops being a principle and becomes an assertion: the planner and the progression policies must
not import the store. That is a test, and it is in §A3 below.

## What already exists

More than it looks like. `providersFromEnv` in `packages/ai/src/index.js` already returns four
providers:

```js
{ fast, deep, local, vision }
```

Those are **task** tiers, not customer tiers. `fast` reads a typed log, `deep` writes the note a
client actually reads, and the split exists so the cheap model never quietly writes the prose
somebody trusts. `local` is a *failover* beneath the hosted pair, answering when the hosted one
is unreachable, and with nothing hosted configured it stops being a failover and becomes the
model. `vision` is Ollama-only by policy and always has been, because the pictures it reads are
somebody's body in a gym.

So the axis the request needs already ran through this file. What was missing was that the
provider set was chosen once per *instance*, at boot, and injected into the app
(`apps/api/src/app.js`, the `ai` parameter). Choosing per *request* was the one piece of
genuinely new plumbing, and it was small — `createTiers()` and a one-line resolver, which is
A2 below.

## The shape that survives the constraints

**Three states, not two.** The instance already has a no-model state that works, and it should
stay named:

| State | Backing | Who gets it |
|---|---|---|
| **Template** | no model configured | any instance; already ships, `/api/ai/status` reports it |
| **Free** | the deployment's own Ollama | clients, and coaches whose subscription has lapsed. The floor nobody can fall through |
| **Premium** | the hosted model, plus retrieval where a corpus and an embedding model are configured | a coach who is paying or trialling |

**Separate retrieval from model quality.** This is the load-bearing decision in this document.
They are orthogonal, and treating them as one thing is what makes the plan depend on sanctions
going away:

- A local seven-billion-parameter model with good retrieved context and citations beats a
  frontier model answering from memory on a factual question about training science. Retrieval
  is the differentiator.
- Retrieval runs entirely on the deployment's own hardware: local embeddings through Ollama,
  vectors in the Postgres that is already there. No API, no bill, no sanctions surface.
- A hosted model then becomes optional polish on the language, not the source of the knowledge.
  If constraint 2 resolves badly, the paid tier still has something real in it.

So: **build retrieval first, and make the hosted model the last and most deletable part.**

## The corpus, which is where the risk actually is

Fine-tuning was the wrong tool twice: it does not reliably install facts, and it makes wrong
answers more confident. Retrieval fixes both. What it does *not* fix is rights, and it is worth
being exact about what moved.

The copying act moves from training to ingestion. Download several thousand books, chunk them,
embed them and store the result, and the instance is holding a derived copy of several thousand
copyrighted works and selling access to output from it. That is the same category as the
exercise-media blocker in [MEDIA_OPTIONS.md](MEDIA_OPTIONS.md), and worse in one respect: the
artwork is decoration on a free product, whereas this would be the substance of a paid one.

What retrieval genuinely buys is that the exposure is *addressable after the fact*. A source can
be deleted, a chunk can carry its own attribution, and output can quote briefly and link out
instead of reproducing. None of that is possible once text is in weights. So the rules are
about the corpus, not the architecture:

- **Open access only, for anything ingested.** PubMed Central's open-access subset, SportRxiv,
  and the CC-BY journals cover most of what matters in strength and conditioning. A source whose
  licence cannot be named does not get ingested.
- **Abstracts where the full-text licence is unclear.** Abstracts are widely redistributable and
  for most papers the finding is in the abstract anyway. Store the abstract, link the paper.
- **Every chunk carries its own licence and author**, exactly as the wger media adapter carries
  `by` and `licence` per image (`infra/scripts/media-set.mjs`). Same problem, same solution, and
  it means one bad source is a `delete` rather than a rebuild.
- **Cite and link every claim, quote short.** A retrieved passage reaches the reader as a
  citation with a URL, never as unattributed prose in a coaching note.
- **The corpus is fetched at deploy time, never redistributed here.** This is the pattern the
  exercise media already uses: `docker-compose.yml`'s `media` service clones the artwork on
  first boot and the repository ships none of it. An `infra/scripts/ingest-corpus.mjs` doing the
  same for papers keeps this repository free of other people's text, which is the same reason
  `media/` is gitignored.

## Ranking, because the literature contradicts itself

The thing most likely to make this feature bad rather than illegal.

Sports science disagrees with itself and the quality range is enormous. A twelve-person
crossover trial and a forty-study meta-analysis retrieve identically under cosine similarity, so
a naive store will cite the weak one with complete confidence. That is precisely the failure the
media matcher already refuses to commit, and the argument transfers word for word: a
confidently wrong picture is worse than no picture, because a reader follows it. A confidently
wrong citation is worse than no citation, for the same reason and with higher stakes, because
somebody loads a barbell from it.

So a chunk is not just text and a vector. It carries study design, sample size, and whether it
was peer reviewed, ranking is a function of those *and* similarity rather than similarity
alone, and a preprint is labelled a preprint in anything the reader sees. Where the retrieved
sources disagree, saying so is the correct output; picking one is not.

## Milestones

Estimates, in the style of WEARABLES.md, and the same caveat applies: they are what the work
looks like from here.

### A1 — Gate the coach drafting route · **done**

Not a feature. A bug, found while writing this document, and fixed before the rest of it was
scheduled.

`apps/api/src/routes/ai.js` consulted the entitlement system **nowhere**. The coach drafting
endpoint `POST /api/coach/clients/:id/ai-review` checked the `workouts` scope and an active
link, and did not check `propose` — while the endpoint that actually sends the result does
(`apps/api/src/routes/coaching.js:108`). So a coach whose subscription had lapsed could spend
model budget drafting proposals they would be refused at the moment they sent one: a cost leak
and a dead end in the interface at once, at every tier.

Two questions came up in the fixing and both are answered in the comment on the route.

**`propose` rather than a capability of its own.** Nothing separate is being bought. Drafting is
the first half of proposing, and a tier that sold one without the other would be selling a
button that does not work. Adding a capability would also mean touching `ALL` and all five rows
of `CAN` in the domain to express something that already has a name.

**The trial clock is not a problem here.** `requireCoach` starts the fourteen-day trial on first
use, and starting somebody's trial because they clicked "draft" would be a surprising side
effect. It cannot happen: the route is unreachable without an active link, a link exists only
because an invite was created, and creating an invite already went through
`requireCoach(…, 'takeClients')`. Anybody who can reach this route has had a clock running for a
while, so the ordinary guard is correct and the non-trial-starting variant would only have been
a second thing to explain.

Two tests in `billing-api.test.js`, in the describe whose stated job is that the gate lands on
the coach and never on the client. One asserts the 402 on drafting for a coach in grace, and was
checked against the unfixed route to be sure it could fail. The other asserts that
`/api/ai/programme` and `/api/ai/review` stay open at every subscription state, for a client and
for a lapsed coach alike, which is constraint 1 written down where a future edit will trip
over it.

### A2 — Per-request provider selection · **done**

`createTiers()` in `packages/ai` builds both surfaces from one read of the environment, and
`routes/ai.js` picks between them per request. The AI package decides how to *build* a tier and
knows nothing about subscriptions; the API decides who gets which.

The resolver turned out to be one line, because the question already had a name:

```js
const tierFor = async user =>
  (await entitlementFor(user.id)).can.propose ? 'premium' : 'free'
```

`propose` is true in exactly the states where somebody is paying or trialling, so **a client
lands on the free tier by construction** rather than by a rule written next to every route —
they have no subscription, so they answer no. A coach in grace or expired lands there too,
because what lapsed is the paid thing and the paid thing includes the model that costs money by
the token. Reusing the capability rather than adding one keeps "may author for a client" and "is
paid up" from drifting apart, which they cannot do while they are the same predicate.

What a free user actually loses is smaller than it sounds, and this is the part worth knowing
before pricing anything: the model's job on the client-facing routes is turning prose into a
brief, `normaliseBrief` validates whatever comes back, and `buildProgramme` computes every
number from the result. So a smaller model is a worse reader of unusual phrasing and a plainer
summary — **not a worse programme**. A test asserts the routines are identical across tiers.

Three things that came out of building it:

- **`/api/ai/status` reports `tier`, read from the entitlement rather than from which object
  came back.** A deployment can legitimately back both tiers with the same model, and reporting
  `premium` there because the two happen to be one object would describe the plumbing instead of
  the account.
- **Vision is not tiered.** It is Ollama-only by policy rather than by cost, there is no cheaper
  version to fall back to, and a form check is something a client uploads about their own lift.
  Tiering it would be gating a client.
- **The coach drafting route uses the premium surface outright**, since the A1 gate above it has
  already established `propose`. One question instead of two, and it is the note a client reads
  verbatim, which is what the fast/deep split was always for.

Five tests in `providers.test.js` for the construction — a deployment with a hosted key and an
Ollama, one with only an Ollama, one with neither, and that a hosted model can never reach the
free tier through the failover chain. `createTiers` takes the variables rather than reading the
environment, like the two functions either side of it, because the shapes worth checking are
deployments the test machine is not.

Seven more in `billing-api.test.js` against an app with two distinguishable fakes. The first
draft of them tested only `/api/ai/status` and **passed with the per-request selection removed
entirely**, because status reads the entitlement directly — it was checking the label, not the
routing. The two that follow a real call through to a provider were added after that, and both
were checked against a hardcoded resolver to be sure they could fail.

### A3 — Retrieval, entirely local · **built, and unexercised in two places**

Everything below is written and tested except the two things this machine cannot do, which are
named at the end of the section. Read that part before believing the rest.

**pgvector, and the feature is optional.** `docker-compose.yml` and CI now run
`pgvector/pgvector:pg16` — the same Postgres with one extension compiled in, so an existing
volume keeps working. But **migration 016 is conditional**: on a database without the extension
it creates nothing, says so in a notice, and `corpus.js` reports the feature absent. A migration
that hard-required pgvector would refuse to apply on every instance built before it, which is a
broken upgrade for a feature nobody has asked for yet. Same shape the vision model already has:
with nothing configured it is missing rather than degraded.

That leaves one trap, and `ensureCorpus()` closes it. A migration recorded as applied never runs
again, so an instance that later moved to a pgvector image would otherwise have the extension and
no table forever, with nothing to say why. The ingestion script calls it before writing anything.

**Migration 016** holds the chunk table, and the provenance columns are the point rather than
decoration. `licence` and `url` are `not null` with non-empty checks, which makes "nothing in the
corpus lacks a licence somebody wrote down" a constraint rather than a convention — the rules in
this document are only worth something if an ingestion script written in a hurry cannot forget
them. `source_id` is what makes withdrawing a paper one delete, which is the whole reason
retrieval is a safer answer here than a fine-tune, and is worthless unless the column exists. Not
in `TABLES` in `sync.js` and never through `log_change()`: instance-wide reference data has no
owner to scope to and no reason to be on a phone.

**Embedding is local, with no hosted variable at all** (`packages/ai/src/embed.js`). Two reasons,
and the second decided it: a per-token price is the wrong shape of bill for the call made
thousands of times at ingestion, and a paid tier that needed a hosted embedding API would inherit
constraint 2 and take the corpus down with it. Spoken to over the OpenAI-compatible `/embeddings`
route, so "your own hardware" does not mean "exactly the server we tested". The dimension is
checked on the first vector rather than by the database an hour into a run.

**Ingestion** (`infra/scripts/ingest-corpus.mjs`) is where the licence rule actually lands, and
what it refuses is the interesting part:

- **NC is refused**, and that is not hypothetical. The first result Europe PMC returned for
  "resistance training volume hypertrophy" on the day this was written was an open-access
  systematic review under `cc by-nc-nd`. Free to read is not free to sell alongside, and an
  ingester that read `isOpenAccess: Y` and stopped there would have taken it. Across 25 live
  records, 5 were refused on licence.
- **ND is refused**, rather than arguing about whether a stored vector is a derivative.
- **An unrecognised or absent licence is refused**, never defaulted. The same rule the media
  adapters follow after Free Exercise DB's claim turned out to have nothing behind it.
- Share-alike is read *as* share-alike. `cc by` is a substring of `cc by sa`, so the match list is
  ordered longest-first and a test asserts that ordering; a shortest-first list would record every
  share-alike paper as CC-BY and silently drop the obligation that makes it different.

Abstracts rather than full text, per the corpus rules above. Europe PMC is the adapter because the
licence arrives *with* the search result rather than in a second lookup per article. A run is
idempotent (upsert on `(source_id, chunk_index)`), survives one paper failing to embed, and prints
what it skipped and why — an ingestion that silently dropped half its input while reporting
success is how a corpus ends up covering nothing.

`npm run corpus:check` is the gate and the sibling of `media:check`: it fails if anything in the
store is under a licence these rules would not accept today, which catches a corpus ingested by an
older version of them and a row somebody put there by hand.

**Ranking** is where the honest work is. Similarity picks the candidates, which is what the HNSW
index can accelerate, and study quality orders them, which it cannot — so `search` over-fetches by
a factor of four and re-ranks. Without the over-fetch, quality weighting could only reorder what
similarity had already chosen, which is most of the point of having it. The weights themselves are
a starting point and **are not validated against anything**; what the tests assert are the
ordering properties they exist to produce, which would still have to hold if somebody retuned
every number. The one that matters: identical text and identical vectors, and the forty-trial
meta-analysis comes back ahead of the one-lifter case study. Relevance still dominates, so a close
case study beats a distant meta-analysis, and it should.

**The citations never come from the model.** The prompt is shown the passage and the title and
*not the URL*, because a model that has seen a link will eventually write one, and a reference a
model typed is a reference nobody can check. The resolvable links travel back beside the note in
`sources`, straight from the store, on the template path as well as the model path — dropping them
on the fallback would make "the model was down" and "there is nothing published about this" look
identical to the coach reading it. The system prompt gains two prohibitions when passages are
present: do not cite, and do not take a prescription from them.

**The invariant is now a test.** `node-contract.test.js` scans every file in `packages/domain` and
fails on an import of `@gymyar/db`, `@gymyar/ai`, `postgres`, `pg`, or anything named corpus. It
was checked against a deliberate violation. That is the constraint-3 promise made mechanical:
retrieval is an import and an import can be asserted about, where a fine-tune would have put the
same influence inside weights that no test could see.

#### What has not been run

Two things, and neither is a detail:

- **No real embedding model has ever run against this.** Ollama is not installed on the machine
  this was built on, so `openAICompatEmbedder` has been exercised only against a fake server.
  Batching, ordering, short batches and the dimension check are all tested; the actual HTTP
  conversation with a real Ollama is not. It is the same class of gap as the wearables work before
  any hardware: the logic is verified and the device has not answered yet.
- **No corpus has been ingested.** The adapter was run against live Europe PMC records up to the
  point of embedding — 20 of 25 storable, 5 refused on licence — so the field names, the cursor
  and the licence rule are confirmed against the real API. Nothing has been written to a store,
  because writing one means choosing sources, and §"What needs a person first" says that decision
  has a legal question attached to it.

The store itself is verified against a real pgvector: 15 tests, including the constraint that
refuses an unlicensed passage and every ranking property above.

Sizing, arithmetic from assumptions rather than measurement, for five thousand open-access
papers at roughly eight thousand tokens each:

| Chunks at 500 tokens, with overlap | ~90,000 |
| Vectors at 768 dimensions | ~280 MB |
| With text and an HNSW index | under a gigabyte |
| One-time embedding on CPU | an hour or two; minutes on a GPU |

Comfortable on the single machine this product is designed to run on.

### A4 — The hosted premium model · 2 days

Last, smallest, and the most deletable. A second provider set for active subscriptions, chosen
by the A2 resolver, with the retrieved context in the prompt either way. If constraint 2
resolves badly this milestone is dropped and the paid tier keeps the corpus, which was always
the part worth paying for.

## What this touches

- `packages/ai/src/index.js` — provider selection becomes a function of the caller.
- `apps/api/src/routes/ai.js` — entitlement checks on the coach-side routes only.
- `apps/api/src/app.js` — the injected `ai` becomes a resolver.
- `packages/domain/src/entitlement.js` — possibly one new capability; possibly none, if A1's
  reading is right and coach drafting is simply `propose`.
- `packages/db` — migration 016 and the retrieval queries.
- `docker-compose.yml` — the database image, and an ingestion service in the shape of `media`.
- `apps/site/privacy.html` and `apps/site/en/privacy.html` — see below.
- `apps/api/src/rate-limit.js` — the model buckets are per account and tier-blind today.

## Privacy, and what it costs elsewhere

The privacy policy does not currently mention that a configured model provider receives
anything, which is drift already recorded in [LEGAL_BRIEF.md](LEGAL_BRIEF.md) §3.7: with a
hosted key set, `interpretBrief` sends up to two thousand characters of somebody's free text and
`explainChange` sends a client's **name** along with the change. Both pages need a paragraph
before either tier ships, and A4 makes that paragraph load-bearing rather than merely accurate.

The retrieval store itself is the easy half: it holds published papers, not user data, and no
user text leaves the instance to query it. A local-only free tier is in fact a privacy
*improvement* over the current default, because nothing leaves at all.

## Deliberately not built

- **Fine-tuning on the corpus.** Wrong tool: it does not install facts reliably, it makes errors
  more confident, and it makes a rights problem unfixable by putting text into weights.
- **Retrieval on the client-facing routes**, at first. Programme generation and log parsing do
  not need literature; they need the planner and the parser, which already work. Adding
  citations to a client's own screens is a later question and a bigger one.
- **Any retrieved text influencing a number.** See constraint 3. The premium tier explains and
  cites. It does not prescribe.
- **A hosted embedding API.** Same sanctions surface as hosted inference, for a job a local
  model does well.
- **Gating anything a client does.** Constraint 1.

## Done means

- [x] A free coach drafts with the local model; an active coach drafts with the hosted one
- [x] …and with retrieval behind it, where a corpus and an embedding model are configured
- [x] A client's programme generation, review and typed logging are never refused at any tier,
      and the programme itself is identical across them
- [x] `/api/ai/status` names the tier that answered as well as the provider
- [x] An expired coach cannot spend model budget on a proposal they cannot send
- [x] Every chunk in the store names its licence, its author and its URL, and one source can be
      deleted without rebuilding
- [x] Nothing in the corpus lacks a licence somebody wrote down: a database constraint, plus `corpus:check`
- [x] The domain cannot import the store at all, which is the stronger form of that
- [x] Retrieved claims reach the reader as citations with links, and preprints say so
- [ ] Both privacy pages describe what a configured provider receives
- [x] The instance still works with no model and no store, in template wording

## What needs a person first

In order, and none of it is code:

1. **Is hosted inference payable from Iran?** Constraint 2, and it decides whether A4 exists.
   [LEGAL_BRIEF.md](LEGAL_BRIEF.md) question 17.
2. **Is a corpus of published literature ingestible and sellable?** A new question for the same
   review, closer to question 6 on share-alike than to anything already on that list, and no
   longer hypothetical: A3 built the machinery, enforced the licence rules in three places, and
   **ingested nothing**, because choosing sources is the part with the legal question attached.
   It stops there on purpose. Counsel decides whether anything is ever put in it.
3. **Is this what the paid tier should sell at all?** Tiers are client-count based today at
   five, twenty-five and one hundred (`packages/domain/src/entitlement.js`), and prices are
   placeholders (`apps/api/src/payments/pricing.js`). A `pro` coach running premium AI across a
   hundred clients costs roughly twenty times a `solo` coach at about five times the price, and
   the rate-limit buckets are tier-blind. More capacity may be a better thing to sell than
   better prose.
4. **One paying coach, first.** There are none. This is the "build phase 10 instead of touching
   the blockers" risk in its exact shape, and every new AI surface is another screen wanting
   exercise artwork that is not yet licensed. A1 is done, because a lapsed subscription reaching
   a metered endpoint is a bug rather than a feature, and A2 because it is what stops a hosted key
   being spent on people who are not paying for it. A3 is built and switched off — it costs
   nothing until an operator configures an embedding model and ingests something, which is the
   right place for it to wait. A4 is worth doing when somebody is paying for the thing it would
   improve, if it turns out to be purchasable at all.

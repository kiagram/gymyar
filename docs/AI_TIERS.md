# Two AI tiers, and the corpus underneath the paid one

A plan, not a build. Nothing in this document is implemented; `packages/ai` today has one
provider set for the whole instance and no retrieval of any kind. It is written the way
[WEARABLES.md](WEARABLES.md) was written before any of that existed: the constraints first,
then the shape that survives them, then milestones somebody can cost.

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

So the axis the request needs already runs through this file. What is missing is that the
provider set is chosen once per *instance*, at boot, and injected into the app
(`apps/api/src/app.js`, the `ai` parameter). Choosing per *request* is the one piece of
genuinely new plumbing, and it is small.

## The shape that survives the constraints

**Three states, not two.** The instance already has a no-model state that works, and it should
stay named:

| State | Backing | Who gets it |
|---|---|---|
| **Template** | no model configured | any instance; already ships, `/api/ai/status` reports it |
| **Free** | the deployment's own Ollama | every client, and every coach, always |
| **Premium** | retrieval, plus a better model where one is reachable | coach-side drafting on an active subscription |

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

### A1 — Gate the coach drafting route · half a day

Not a feature. A bug, found while writing this document.

`apps/api/src/routes/ai.js` consults the entitlement system **nowhere**. The coach drafting
endpoint `POST /api/coach/clients/:id/ai-review` checks the `workouts` scope and an active link,
and does not check `propose` — while the endpoint that actually sends the result does
(`apps/api/src/routes/coaching.js:108`, `requireCoach(user.id, 'propose')`).

So a coach whose subscription lapsed can spend model budget drafting proposals they cannot send.
That is a cost leak and a dead end in the UI at once, and it exists today at every tier.

One subtlety, and it is the reason this is half a day rather than an hour: `requireCoach` starts
the fourteen-day trial clock on first use. Starting somebody's trial because they clicked
"draft" is a surprising side effect, so this wants the non-trial-starting variant of the check,
or a deliberate decision that drafting is what begins a trial.

### A2 — Per-request provider selection · 2 days

The AI instance is built once and injected. This makes the provider set a function of the
requesting user's entitlement instead:

- A resolver that answers "which providers for this user", returning the local set for a client
  or a free coach and the premium set for an active coach.
- Client-facing routes always get the free set. This is constraint 1, in code, and it wants a
  test that fails if a client-facing route ever consults entitlement.
- `/api/ai/status` reports which tier answered, alongside the provider it already reports.
  Users forgive a template and do not forgive being told a template was intelligence, and the
  same is true of the free model.

### A3 — Retrieval, entirely local · 5 to 7 days

- **pgvector.** `docker-compose.yml` runs `postgres:16-alpine`, which does not have it. Either
  `pgvector/pgvector:pg16` or a small image of our own. Changing the database image is normally
  expensive for self-hosters; there are currently zero deployments, which makes this the
  cheapest moment this change will ever be.
- **Migration 016**, adding the chunk table: text, vector, source id, licence, author, URL,
  study design, sample size, peer-review status. Not in `SYNC_TABLES` and never in
  `log_change()`: this is instance-wide reference data, not anybody's rows.
- **Ingestion** (`infra/scripts/ingest-corpus.mjs`) against the open-access sources, honouring
  the corpus rules above, embedding locally through Ollama with `nomic-embed-text` or
  `mxbai-embed-large`. Idempotent, resumable, and it records what it skipped and why.
- **Ranking** on design and sample size as well as similarity, per the section above.
- **The invariant, as a test:** `packages/domain` must not import the store, and a generated
  programme must be byte-identical with the store populated and empty. `plannerReach()` and the
  determinism test in `planner.test.js` are the existing hooks for this.

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

- [ ] A free coach drafts with the local model; an active coach drafts with retrieval behind it
- [ ] A client's programme generation, review and typed logging are identical at every tier,
      and a test fails if a client-facing route ever consults entitlement
- [ ] `/api/ai/status` names the tier that answered as well as the provider
- [ ] An expired coach cannot spend model budget on a proposal they cannot send
- [ ] Every chunk in the store names its licence, its author and its URL, and one source can be
      deleted without rebuilding
- [ ] Nothing in the corpus lacks a licence somebody wrote down
- [ ] A generated programme is byte-identical with the store full and empty
- [ ] Retrieved claims reach the reader as citations with links, and preprints say so
- [ ] Both privacy pages describe what a configured provider receives
- [ ] The instance still works with no model and no store, in template wording

## What needs a person first

In order, and none of it is code:

1. **Is hosted inference payable from Iran?** Constraint 2, and it decides whether A4 exists.
   [LEGAL_BRIEF.md](LEGAL_BRIEF.md) question 17.
2. **Is a corpus of published literature ingestible and sellable?** A new question for the same
   review, and closer to question 6 on share-alike than to anything else already on that list.
3. **Is this what the paid tier should sell at all?** Tiers are client-count based today at
   five, twenty-five and one hundred (`packages/domain/src/entitlement.js`), and prices are
   placeholders (`apps/api/src/payments/pricing.js`). A `pro` coach running premium AI across a
   hundred clients costs roughly twenty times a `solo` coach at about five times the price, and
   the rate-limit buckets are tier-blind. More capacity may be a better thing to sell than
   better prose.
4. **One paying coach, first.** There are none. This is the "build phase 10 instead of touching
   the blockers" risk in its exact shape, and every new AI surface is another screen wanting
   exercise artwork that is not yet licensed. A1 is worth doing now because it is a bug. The
   rest is worth doing when somebody is paying for the thing it improves.

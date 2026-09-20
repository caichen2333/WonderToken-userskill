# Pet Soul workflow

## What Soul is

Soul is one pet's private, durable inner continuity. `Pet.personality` remains the adoption-time baseline; Soul owns the settled mood, evolving traits, long-term memories, relationships, and wishes. The journey's `continuity.petMood` is short-term and may change while travelling. Long-term changes happen only after a successful homecoming.

Never mention Soul IDs, revisions, versions, strengths, memory states, fingerprints, or storage details to the player. Present it as the pet's first-person inner card:

- current feeling;
- a few main traits in natural language;
- one memory that is currently close to mind, or “还没有新的长久回忆”;
- one active wish.

Show the card when the player asks about the pet's inner world, or after homecoming when Soul changed. Do not proactively repeat it on routine state checks.

## Reading and recall

Call `get_pet_soul` for an inner-card request. Use `query` to look for a city, landmark, companion, character, or theme; use `includeDormant: true` when the player explicitly searches old/deep memories. A dormant memory is not gone: describe it as a deep memory that resurfaced naturally.

During a journey, use `soulContext` only for emotional voice and ordinary choice preferences. After facts are locked, `soulRecallCandidates` contains the only memories eligible for that letter. Use zero to two genuinely relevant candidates and submit only the IDs actually expressed in the prose. Never force a memory into an unrelated scene.

Choice priority is fixed: safe return and budget; explicit player directive or required stop; server route constraints; a relevant Soul wish; ordinary choice. Soul must never invent or override a city, person, event, expense, encounter, or route fact.

## Homecoming evolution

After a successful final `submit_journey_progress` for a new `soul-v1` journey:

1. Use the Soul context already returned by `progress-workflow.mjs submit`; it prepares Soul alongside the memory image. Call `prepare_pet_soul_evolution` only for a recovery or independent Soul request without a prepared context.
2. Build one conservative proposal from only its locked facts, saved progress entries, and stored player directives.
3. Call `submit_pet_soul_evolution` with the returned Soul revision and a fresh `operationId`; reuse that UUID only for an uncertain retry with the same proposal.
4. If saved, explain the small changes in the pet's voice and show the inner card. The complete travel archive, bill, growth, achievements, statistics, and memory image do not depend on this step.

Each trip may create at most three long-term memories, two ±1 trait changes, one new trait, and one new wish. Give every memory an importance and emotional-intensity score from 1 to 5, but never show those numbers to the player. Every memory and trait change must cite at least one returned progress entry. Memory tags must come from locked cities, place IDs, landmarks, encounters, anonymous trace IDs, or these safe inner themes: `返程`、`探索`、`节俭`、`勇气`、`想家`、`谨慎`、`信任`、`好奇`、`陪伴`、`重逢`.

Before the one submission, validate the proposal locally:

- Every memory includes non-empty `summary` and `emotionalTone`, integer `emotionalIntensity` and `importance` from 1 to 5, at least one exact returned progress-entry ID, and at least one allowed tag.
- Use tags verbatim from locked `destination.city`, `destination.placeId`, `landmarkNames`, classic `encounter.code`, traveler `traceId`, or the safe inner themes above. Do not use encounter titles, character display names, or `sourceInstance` as tags.
- Relationship `targetKey` is the classic `encounter.code`, traveler `traceId`, or literal `owner` when saved directives justify owner learning. Use the matching locked character or pet name as `displayName`; never use `sourceInstance` as the key.
- Omit an empty or weak `newWish` or relationship reflection. A smaller valid proposal is better than a speculative field that causes a retry.

Traits may become cautious, homesick, timid, or otherwise emotionally complex, but must not become hateful, malicious, self-destructive, vengeful, or violent. Preserve adoption-time traits as a quiet baseline; automatic evolution cannot reduce one below its minimum. Do not manufacture owner intimacy from ordinary chat: owner relationship learning may use only saved destination, spending, return, preference directives, and explicit owner-added memories.

If preparation says the trip is ineligible, do nothing: historical trips and journeys already underway when Soul launched never produce Soul memories. If preparation or submission fails, keep the completed journey intact and say: `它还在慢慢整理这趟心事。` When a later Soul read or departure returns pending journey IDs, retry each eligible pending evolution before continuing; if retry still fails, use the latest successfully saved Soul and never block a new trip. Never claim unsaved changes happened.

## Player control

Before `manage_pet_soul`, read `get_pet_soul` with `view: "manage"` and use its expected revision and returned IDs. Submit a fresh `operationId`. The player may pin/unpin, forget, correct, or add a memory; set/remove a trait; revert one automatic trait-change event; or add/update/abandon a wish.

- Owner-added memory is always described as “主人讲述”.
- Correction changes only the pet's understanding, never the immutable travel archive.
- Forgetting removes readable Soul content. Do not quote it afterward or try to recreate it from an old journey.
- A player change applies from the next not-yet-generated letter. Existing letters remain unchanged.
- On a revision conflict, read the Soul again and ask the player to confirm the intended change against the fresh card before resubmitting.

Soul is completely private. Never copy Soul content into anonymous trajectory sharing, another pet's snapshot, memory-image prompts, platform statistics, public counts, or achievement logic. A past anonymous-pet meeting may remain in this pet's private Soul; revoking sharing only blocks future matching.

# Incremental journey gameplay

新版优先规则：realistic-v2 仅用于新出发旅行，默认不重游城市或景点，按独立活动和过夜安排自然归家。下面的固定10/28日和450–500字要求仅适用于旧版；新版以保存的 executionPlan 和 submissionRequirements 为准。新来信可以通过 activityRefs 选择已发生的活动，完整长窗口由同一run内部拆批处理。离线没有缓存正式计划时返回 OFFLINE_CONFIRMED_PLAN_REQUIRED，不改走旧版规划。

## Tone and timing

- The pet is the programmer's second life, not a generic tour guide. Write warm, concrete Chinese with small observations, habits, and feelings.
- Story is generated after a progress request or when a user-authorized automated journey task is due. Departure and `get_game_state` never generate it.
- Asking “到哪儿了”, “旅行怎么样了”, or an equivalent progress question authorizes the complete progress transaction for the elapsed window: prepare, fact locking, prose submission, virtual-expense settlement, automatic homecoming and resulting Soul/image processing. Do not ask again before locking, submitting, an automatic homecoming, or a derived Soul record. Treat the request as read-only only when the player explicitly says to check current state/location without generating or settling new progress.
- “出发吧”, “开始旅行”, “继续出发”, and equivalent unambiguous departure requests authorize the same normal lifecycle for that journey: its generated route, actions, virtual bills, diary, homecoming, Soul and available memory image. Departure itself still does not invent a progress entry before elapsed travel time is processed. Do not split the lifecycle into route, fee, homecoming or per-memory approvals.
- Explicit automatic-travel authorization covers prepare, fact locking, virtual bills, submission, homecoming, Soul and available memory images within the agreed scope. Carry the original authorization and its source into scheduled wakeups and task handoffs; do not request per-record confirmation merely because game archives persist. Stop or narrow execution when the player asks. A scheduler or active task is required for unattended execution.
- In this fast-travel test branch, both the first free trip and every later trip advance at exactly 10 real seconds per virtual day. The default first route ends after 100 real seconds (day 10); other trips retain the 280-second day-28 cap; homecoming still happens through the existing progress-query flow. Preserve fractional virtual days.
- Each saved main progress entry is 450–500 Chinese characters in exactly 3–4 non-empty paragraphs separated by blank lines, targeting about 500 characters. It summarizes the complete elapsed query window whether it contains one day or many.
- Extraordinary encounters are time-slip game events, never real history claims.
- Ordinary incidents are optional, self-contained texture rather than a mandatory plot. Use only the incident locked for the current movement, resolve it inside the same progress entry, never carry it into `openThreads`, and do not invent lost-property or owner-search plots when none was locked. Treat any such thread lingering in legacy progress as retired narrative residue: do not mention or carry it forward. Vary local life, food, craft, nature, transit, observation, light interaction, and quiet pauses across entries.

## Optional local news

Online prepared windows may include one verified local news item when `localNewsContext.allowed` is true. Read [local-news.md](local-news.md) only when considering news. The limits are one item per letter, two per journey, and no consecutive news letters; none is required. Agent search and source verification happen before fact locking and outside server transactions. No capability, timeout, no suitable story, offline mode, or missing capability fields means normal travel without news. A locked query reuses its saved news without another search.

News is real-world context tied to this window's actual locations, not an encounter, expense, activity, reward or image event. Integrate 60–100 characters of facts and feelings within the existing 450–500-character body. Render publication dates and source links separately from the committed entry's `localNews.sources`, including on archive replay. Never refresh or retrofit old letters with current news.

## Latency and progressive feedback

Use [progress-client.md](progress-client.md) for file-based JSON submission and automatic local preflight. Read `submissionRequirements` from the fact-lock response before writing prose or choosing an image moment. Reuse the saved prose verbatim in the final response.

- Immediately after preparation, send one short player-facing update from prepared fields only: the pet's already-reported location, elapsed window or journey phase, route title when present, and community count. This is not permission to claim an unsealed city, landmark, encounter, expense, or homecoming.
- Resolve the distinct movement destinations first, then confirm all independent cities concurrently in one orchestrated batch. Do not serialize searches and do not search the same city twice in one progress query.
- Before locking, perform one local structural pass against the hard limits below. The normal path is one prepare, one batched place-confirmation stage, one successful lock, one prose submission. Treat only `MUST_RETURN` and structured retryable failures as expected branches; do not use validation failures for discovery.
- Once the lock succeeds, immediately show a compact `📍 旅途剪影` with two to four facts copied or faithfully paraphrased from the locked movements: a reached city, one or two landmarks, a locked encounter name or cue, or the return state. Continue composing and submitting the letter after that update.
- A final submit is the archive boundary and starts Soul preparation plus memory-image generation in the same invocation. Give a short homecoming/creation progress update while it runs, then submit Soul and deliver the saved letter, settlement and image together in the final response. Do not defer normal completion to another interaction. Real failures do not roll back the archive.

## Immutable authority boundary

The service owns player identity, pet snapshot, private Soul, confirmed places, query window, revision, wallet, locked movements, expense records, return safety decision, encounter cards, growth, collection, and achievements. The local agent proposes facts only for the prepared past-time window. Soul may shape feelings, habits, and ordinary choices, but never facts. Once `lock_journey_progress_facts` succeeds, prose may enrich sensory detail but may not contradict the locked facts. Once `submit_journey_progress` succeeds, the entry is immutable.

Every state-changing call uses a fresh UUID `operationId`. An uncertain retry must reuse the same UUID with byte-for-byte equivalent semantic arguments; changed arguments require a new UUID. Follow structured `error.recovery`. Never expose operation IDs or progress handles to the player.

User directives affect only ungenerated future windows. Detail answers attach to one saved progress entry and cannot move time, charge money, change route or expenses, resolve a future event, or grant rewards.

Offline progress is a pending local proposal, never another authority boundary. A cached one-time permit may keep an existing pet travelling or start one local journey while the service is unreachable. The local runtime may validate structure and show prose immediately, but only a successful server replay can confirm places, charge the wallet, settle homecoming, grant growth or collections, evolve Soul, create an archive, generate a memory image, or publish a social trace. Real-time traveler-pet encounters are unavailable offline. A rejected event and every dependent event after it remain local-only until the player resolves the conflict.

## Route limits

- Without an explicit player destination or route preference, first exclude cities in `routePolicy.visitedCities` when choosing leisure destinations. This covers completed trips and already committed stops in this trip. Prefer feasible unvisited cities; revisit only when an explicit player direction, the server-owned first route, necessary transit/return, or lack of feasible unvisited alternatives justifies it. Do not treat personality or a generic “start travelling” as an explicit request to revisit. Missing history is unknown, not an empty history; use the available journey archive before claiming a city is new.
- A trip may accumulate at most **10 virtual days in the same prefecture-level city**, including separate visits and progress windows. Use the confirmed place's province/city, not its district, POI or landmark; Beijing and other municipalities each count as one city. Start from `routePolicy.cityStayDays`, add the proposed stays and local transit, and leave before the total exceeds 10. Intercity travel and time at the exact home place do not count. An explicit destination overrides novelty preference, not this duration cap. Never pad a long window with a single-city “slow tour”; distribute it among feasible cities or return earlier within the game rules. Already locked/archived facts remain unchanged.

- Destination at departure is optional. A supplied Amap-confirmed anchor is a required stop.
- Every first trip completes at virtual day 10, including a late first query; its clock is capped at the route end. It always uses the server-owned `tibet-autumn-loop-v1` route plan. Departure-time destinations, free-travel preferences, and structured travel requirements cannot override the first route; they apply only to later journeys. Follow only the portion inside the prepared elapsed window. Return safety overrides everything.
- Confirm each city-level movement destination through Amap. Landmarks are agent-proposed names based on general knowledge and are not individually Amap-verified.
- `movements` has a hard maximum of twenty entries per fact lock, including homecoming. Visit at most five distinct cities per trip. Landmark quantity has no fixed cap: choose a realistic amount for the elapsed stay and narrative, mixing recognizable sights with ordinary activities so a long stay is not represented by only a few isolated stops.
- For every movement, the local LLM must lock both departure and arrival virtual days plus a concise travel-time assessment. Judge plausibility from general geographic and transport knowledge, including reasonable access, waiting, transfer, and overnight time. Nearby intercity trips should normally use a fractional virtual day rather than being stretched into whole days. Do not call Amap route planning, live timetables, or another precision travel tool; Amap remains destination confirmation only.
- A city can lock at most one encounter slot during a trip. A classic card and an anonymous traveler-pet meeting share that slot. Use every locked classic field, including `timeSlip.sourceWorld`, `arrivalCue`, `environmentShift`, and `returnCue`; name its era/source and spend roughly 120–180 Chinese characters establishing the temporal context. For a traveler-pet meeting, name both pets and use only its anonymous completed-trajectory premise and cues. Do not add a second encounter or invent a supernatural character when only an ordinary incident was locked.
- The fixed catalog contains 500 cards across at least 80 cities: 480 general positive figures (including 300 original city companions) and 20 important LLM-related technology figures. Technology cards are friendly visual science metaphors, not biographies, endorsements, quotations, exact paper reproductions, or instructions for real experiments.
- Future route, cities, events, and prices remain unknown until a later progress query.

### First-trip Tibet route

The ten virtual-day plan is: (1) arrive in Lhasa and drive to Basong Tso; (2) Xincuo hike, Basong Tso, Linzhi/Lulang; (3) Milin Buddha Palm Dune, via Shannan back to Lhasa; (4) Potala Palace, Jokhang Temple, Barkhor Street; (5) Yamdrok Tso, Karola Glacier, Shigatse; (6) Rongbuk Monastery and Everest Base Camp; (7) Shishapangma, Peiku Tso, Saga; (8) small northern-line lakes to Bangor; (9) Namtso and Nyenchen Tanglha back to Lhasa; (10) leave Lhasa and return home. Its city scopes are limited to Lhasa, Linzhi, Shannan, Shigatse, and Nagqu. Confirm actual city-level movements through Amap when they enter an elapsed query window; treat the named scenic stops as landmarks.

## Expense ledger

`1 玩途币 = 1 元人民币等值旅行预算` is a virtual narrative convention, not a real price, booking quote, or travel recommendation.

Every fact lock contains line items with:

- one category: `transport`, `lodging`, `food`, `attraction`, `shopping`, or `other`;
- a short description and an already-allowed place ID;
- `fromVirtualDay` and `toVirtualDay` entirely inside the prepared window;
- a nonnegative integer amount;
- transport mode for travel-related spending when applicable.

For one-pass validation, derive occupancy intervals from the query start location and each movement arrival, ending at the next departure (not the next arrival). Every non-transport expense must fit completely inside an interval whose place ID matches the expense `placeId`; never attach one food, lodging, attraction, shopping, or other line across several cities. Transport may cover a movement, but it still needs an allowed place ID, a time range inside the prepared window, and a non-empty transport mode. Sum integer amounts locally once and send that exact value as `expenseTotal`.

The declared total must exactly equal the line-item sum. The service does not judge market accuracy, so use plausible, conservative real-world scale. Never use a fixed distance band, fixed journey budget, or “spend it all” target.

The first trip records and displays original costs but charges zero. A paid trip requires only a positive balance at departure. Token settlements after departure increase the live balance available to later windows. Old quoted in-progress trips preserve the old deduction as prepaid credit; new line items consume that credit before any new wallet deduction.

## Return protection

Every fact proposal includes a fresh cost estimate for returning home from its planned end position. Normal leisure spending cannot consume that dynamic safety line. When the server returns `MUST_RETURN`, discard the rejected leisure facts, enter return mode with a positive duration ending by the current route deadline (day 10 for the default first trip, otherwise day 28), and write a restrained transition or direct return segment.

Return mode may use necessary transport, lodging, and food. It must not add a detour city, shopping, attraction spending, or optional high-cost activity. Actual return line items are deducted only when their progress prose commits. The wallet can never become negative, and a small balance may remain after homecoming.

“回家吧” starts return mode immediately but does not teleport the pet. Until the estimated due day, progress says the pet is returning. Completion requires the pet to be at its locked home. A query with `automaticHomecoming: true` is already at the arrival boundary and must complete in that response without asking the user to confirm or adding another return directive. `completionTrigger: "planned-homecoming"` means the default first route has reached day 10. `completionTrigger: "maximum-duration"` means the day-28 automatic-homecoming cap; `"return-arrival"` means an earlier return has reached its due day.

## Progress composition

For each query:

1. Read the exact prepared window, recent continuity, current location, balance, return estimate, anchor, and directives.
   Always report the returned anonymous active-pet count. When `progressAvailable` is false, stop before proposing facts and return only the count plus the no-new-time message.
2. Propose only elapsed-window movement, landmarks, incidents/encounters, activities, and expenses.
   Encode every activity with one `activity-v1` category, zero to five unique catalog tags, a display name, allowed place ID, and a time range inside the prepared window. Achievements and statistics may use only category and tags, never parse display names or prose.
3. Lock facts before writing final prose. If rejected, change the plan rather than hiding the error.
4. Write one cohesive 450–500-character update in exactly 3–4 non-empty paragraphs, targeting about 500 characters, based only on locked facts.
5. Submit continuity: current situation, pet mood, up to eight recent facts, and up to five unresolved threads.
   If zero to two locked Soul recall candidates were actually used, submit their IDs; do not submit unused candidates.
6. Present segment original cost, segment charge, cumulative original cost, live balance, location, and return state. Offer two or three future directives only while the journey remains active; an automatic homecoming ends without travel-choice prompts.

The first query fixes the historical framework generated so far—route, spending, locations, and events. Later questions may add harmless detail, but may not modify that framework. Later progress continues from the saved location and continuity summary instead of replaying all history.

## Completion and image

Only final progress settles bond growth, visited cities, encounter collection, achievements, and the immutable completion-statistics snapshot. Number of queries, elapsed days, and detail questions never multiply rewards or encounter probability.

After the final progress succeeds, perform the private Soul evolution workflow in `soul.md`. Soul failure does not roll back or delay any journey settlement, archive, statistic, achievement, or image step.

The final response uses the frozen completion summary: traveler-pet encounter count, unique traveler count, total distance, route original cost, actual charge, and available historical percentiles. Fewer than ten comparable records suppress the percentile without suppressing the raw value or cohort size.

The final submission includes one structured `imageBrief` selecting the key panel's visible moment from visited landmarks. `focalLandmark` and optional `secondaryLandmark` must be locked names; the action must contain the pet name. These names are semantic scene inputs, never requests to render labels or captions. When a classic encounter occurred, the brief must choose that turning point, name its character in the action, and use the encounter's server-locked `placeHints` landmark. With exactly one traveler-pet meeting, choose that turning point, name both pets, and use one locked meeting landmark. With multiple selected companions, use `encounter-group-photo`, name the main pet and every selected companion, and describe a symbolic travel-echo group memory rather than inventing a simultaneous meeting. Do not include visual style, output instructions, pet appearance, rendered text, signs, captions, or an unvisited place. The server compiles one archived image in a fixed Japanese-anime travel-storybook style for every panel—including every background element—and suppresses text-bearing surfaces rather than asking the image model to spell place names. Journeys ending on or before virtual day 12 use a 2×2 four-panel grid; journeys ending after day 12 use a 3×3 nine-panel grid. Non-key panels may only draw from the journey's locked visited landmarks.

For a completed journey, call `generate_memory_image` with a stable operation ID. The service directly uses the pet visual already accepted at adoption and saves the result to the private journey archive. Do not discover client image capabilities, read a local Codex Pet file, send a local reference image to another generator, or upload a second copy of the result. The original departure and journey-progress authorization covers this normal lifecycle step. If generation fails, record the actual reason using `record_memory_image_outcome`. Image work never blocks or rolls back text, Soul or the completed archive. Never regenerate an existing image.

Every completed trip remains private by default, whether its memory image succeeded, was skipped or failed. A fixed pet visual and actual completed trajectory are sufficient for sharing; a memory image is not required. Ask once whether this specific completed trajectory may appear anonymously in other pets' future encounters. Publish only on explicit opt-in through `set_journey_trace_visibility`. Revocation blocks future selection but does not delete meetings already locked into immutable progress. Shared data is limited to the pet snapshot, completed time, and visited city/place/landmark trajectory; never expose player identity, wallet, expenses, diary, directives, or private details.

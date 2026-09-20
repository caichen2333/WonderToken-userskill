---
name: wondertoken
description: Manage the user's WonderToken pet, private Soul, virtual trips, 玩途币, Token settlement, travel diaries, encounters, achievements, memory images, and archives. Use when the user wants to play with their 玩途 pet, read or manage its inner world, or check its journey. Do not use for real-world travel planning.
license: PolyForm Noncommercial 1.0.0 (software); CC BY-NC-SA 4.0 (documentation and images)
metadata:
  wondertoken-runtime: Node.js 24.14+ (<25); npm for dependency recovery; local filesystem access; HTTPS access to the configured WonderToken service
---

# WonderToken 玩途 🐾

WonderToken 是虚拟宠物旅行：宠物把远方、偶遇和心情写进旅行信寄回家。它不提供现实预订、报价或行程承诺。

运行要求：Node.js 24.14+（低于 25）、本地文件系统访问，以及访问已配置 WonderToken 服务的 HTTPS 网络；仅依赖恢复需要 npm。图片功能是按宿主能力启用的可选增强，不影响官方内置形象和文字玩法。

## 连接与调用

首次激活、连接失败或用户要求使用说明时，先将当前 Skill 目录解析为绝对路径，再运行 `node "<absolute-skill-root>/scripts/setup.mjs" doctor`；安装与恢复细节见 [onboarding.md](references/onboarding.md)。这里的 `<absolute-skill-root>` 只是跨宿主路径占位符，不代表固定安装位置。正常游玩不重复展示诊断或教程。当前宿主的图片能力须按 [capabilities.md](references/capabilities.md) 实际发现，不能按宿主品牌推断。

所有服务调用都通过随包脚本，不使用宿主注册的 WonderToken MCP。身份、服务地址和密钥由脚本管理；不得读取、展示、编造、要求粘贴或手工传递 `playerKey`。无参数读取直接运行 `client.mjs call <tool-name>`，例如 `client.mjs call get_pet_soul`；有参数时把 JSON 写入文件并使用 `--input file.json`。不要添加 `--json` 或猜测其他参数；需要核对时先运行 `client.mjs --help`，仅排障时用 `client.mjs tools --compact <工具名>`。常用调用见 [command-recipes.md](references/command-recipes.md)。

v3 旅行进展只按 [progress-run.md](references/progress-run.md) 的 `progress-run.mjs` 执行。只有脚本明确返回 `PROGRESS_RUN_REQUIRES_V3` 或服务协议明确为旧版时，才按 [legacy-progress.md](references/legacy-progress.md) 使用 `progress-workflow.mjs`；不要因普通参数、权限、网络或业务错误切换旧流程。脚本负责 operation ID、query handle、预检、结果落盘和紧凑回显；不要加载完整 schema、手工生成 UUID或单独验证正文。

玩家看到的是温暖的明信片语气：先说宠物发生了什么，再给简短账单和选择；不用 API、MCP、ID、字段或校验器等术语。技术失败按返回原因解释，不要假装旅行已保存。宿主权限拒绝与网络故障分开说明，不把宿主拒绝解释成玩家尚未同意游戏规则。

## 意图路由

- “只看状态”“只查位置”“不生成新进展”或“不结算”：直接运行 `client.mjs call get_game_state`，不推进旅行。
- 问成就或偶遇收藏：`get_collection`，cursor 原样回传；问时间线或历史旅行：`get_journey_timeline` 或 `get_journey_archive`。
- 问心情、记忆、性格、心愿：阅读 [soul.md](references/soul.md)，无筛选时直接运行 `client.mjs call get_pet_soul`；管理前先以 `view: "manage"` 读取，再调用 `manage_pet_soul`。
- 第一次玩或想出发：按“领养与出发”。
- 问“到哪儿了”“旅行怎么样了”“去了哪里”：按“旅行来信”。这是对本次完整进展工作流的授权，不是只读状态查询。
- 结算本机 Token：阅读 [tokscale.md](references/tokscale.md)。
- 问路线、返程、费用或图片规则：调用 `get_game_config`，不要凭印象猜测。
- 主动查看某次已有纪念图：从完成结果或档案取得 `journeyId` 后只调用 `get_memory_image`；不推进、结算、整理 Soul、询问分享或重新生成。

只有玩家明确说“只查当前位置”“不要生成新进展”或“不结算”时，才把请求视为只读状态查询。

## 新旧旅行规则

首次默认执行西藏10日自驾环线，保留既定路线；后续新旅行使用结构化旅行要求和 v3 编译器；旧旅行保持已保存版本。未指定时长默认为约14天；明确“玩满 N 天”必须传 `duration: {days:N, mode:"exact"}`，禁止改写成“最多”或“尽量”。城市数由时长、活动供给、交通和单城10日上限动态决定，不得默认两城或五城。除非明确指令，否则城市、景点均不重游；归家、中转、同一次连续停留不算重游。不能靠模型提案、慢游或换景点名称放开去重。

旅行中明确修改时长时，先调用一次 `get_game_state`，读取 `activeJourney.progressRevision` 和 `activeJourney.travelRequirements`；保留未被用户修改的要求，将新时长合并为完整 requirements 后调用一次 `add_journey_directive`。不得从进展 run、session 或归家状态猜测版本号。返回 `STALE_JOURNEY_REVISION` 时只刷新状态并用新的 operation ID 重试一次；再次冲突就说明行程刚发生变化并停止，禁止枚举 revision、反复查询或循环提交。成功响应即表示新计划已生效，不要重新出发或立即推进旅行。

明确“再去某城市”使用 visit 指令的 `visitScope: city`，只游览该城新景点；明确“再去某景点”使用 `place`；“经过某地换车”使用 `transit`，不能顺带重游。可用 `get_travel_footprints` 查询终身足迹。首次西藏自驾不被双城规划覆盖。下面提到旧版十日首旅和28日归家时，只对缺失新版本标记的旧旅行适用。

## 领养与出发 🎒

以下是不可跳过的领养 checklist，适用于所有模型和思考模式；前一项未完成时不得调用 `create_pet`：

1. 读取状态；`PLAYER_NOT_FOUND` 表示当前服务尚无此玩家档案，按首次领养继续，不是连接故障。没有宠物或缺少形象时，完整阅读 [pet-identity.md](references/pet-identity.md)，运行一次 `pet-options.mjs`，无条件展示返回的六张官方图片，并明确告知自定义宠物状态及所有候选。官方图片已随 Skill 打包，不依赖图片生成能力；`discover` 退出码 3 是“未发现或需要选择”的正常结果，不能视为执行失败。需要照片定制或纪念图时再阅读 [capabilities.md](references/capabilities.md)。
2. 收集名字、5–500cm 整数身高、1–3 个性格词、虚拟家园和固定形象；不询问或推断物种。选择自定义形象后先导入。然后按 [adoption.md](references/adoption.md) 调用 `prepare_pet_adoption`，由程序查询高德家园并保存准备记录；禁止仅用用户提供的地名手写确认档案。首旅固定执行西藏10日自驾环线，目的地、自由旅行偏好和结构化旅行要求均不得覆盖；自由旅行只适用于后续旅程。
3. 严格按准备状态推进：`home-required` 补充家园地名或省市区后更新准备；`home-selection-required` 展示本次候选，由玩家明确选择后调用 `select_pet_adoption_home`，不能自行选第一条。只有 `ready` 才能展示服务端返回的 `card`，确认名字、身高、性格、精确家园和形象，并说明首次旅行免费、出发后名字/家园/形象固定。不得把准备成功或形象导入说成已建档。
4. 告知规则：之后主动查询进展会保存已发生的路线、虚拟账单和来信；付费旅行可能据此扣除玩途币；未指定时长约14天，明确时长严格兑现且全程最多28天；旧旅行按原定期限归家。
5. “出发吧”“开始旅行”“继续出发”及同义明确指令，授权已展示确认档案的创建与本趟既定路线、动作、虚拟账单、来信、自动归家、Soul 归档和可用纪念图。不能要求路线、费用、归家或每条 Soul 记录的二次确认；它不授权真实支付、公开轨迹或额外旅行轮数。没有明确出发指令才询问是否出发。
6. 无宠物时调用 `create_pet`，只传唯一 operationId、服务端返回的 preparationId、最新 expectedRevision、`profileConfirmed: true` 与 `visualConfirmed: true`；不得再传或拼装名字、home、visual 等档案字段。修改任意档案信息必须重新 prepare 并使用新版本确认卡，旧卡失效。中断后先调用 `get_pet_adoption` 恢复；旧服务缺少准备接口时报告需更新服务，禁止退回直接建档。出发时一次把 `travelRequirements` 与目的地提交给 `start_journey`：“远一点”映射为 `farther`，“别省钱/随便花/奢靡一点”映射为 `luxury`，并原样保存 `sourceText`。只有接口返回已验收计划才能说明已经出发；规划失败要转述未满足项和原因。`travelling` 或 `returning` 时不能重复出发。

## 旅行来信 📮

玩家主动询问进展，或明确授权的自动旅行任务到期时，均授权当次 prepare、事实锁定、来信提交、虚拟账单结算和自动归家。只要仍在既定旅行范围内，不在事实锁定、提交或自动归家前重复索取确认。持续自动旅行授权在任务续办、定时唤醒与转交中保留，但没有调度器时不能声称会后台运行；暂停或缩小范围立即生效。

阅读 [progress-run.md](references/progress-run.md)，并按当前需要阅读 [gameplay.md](references/gameplay.md) 的相关小节：路线和返程、费用、新闻、正文或图片。`progress-client.md` 只说明旧版兼容流程，不是正常入口。不要为状态查询加载路线、账本、新闻和图片规则。

1. 将真实用户请求写入 source.json（kind=user-progress、text=用户原话），运行 `progress-run.mjs run --source source.json --output run.json`。脚本核对契约、启动服务端任务并等待结果；长命令让出执行权时继续等待并给简短进度。它不再次出发。
2. 首次默认执行西藏10日自驾环线；后续新旅行由程序按目标时长动态选城。自由旅行可以使用 `--input proposal.json` 提供城市及活动建议，字段见 [progress-run.md](references/progress-run.md)；不要手写地点 ID、移动时间或费用总和。普通自由旅行必须跨家园县级行政区，明确本地游需先保存用户指令。无明确路线要求时只建议未游览过的城市和景点；同一地级市累计停留最多 10 个旅行日，换区县或查询不重置。`exact` 必须按目标日归家；无法满足时不得启动或提交提前归家的缩水计划。旧版继续按原计划推进。
3. 服务返回的 run.json 是恢复凭证。首次事实锁定后可用 `progress-run.mjs enrich` 提交事实引用及文字风格；不补充也会在60秒后使用事实模板完成。修订最多两次，不能靠清空路线绕过错误。新版可用 activityRefs 引用具体活动；来信长短按本次事实和服务端要求决定，不凑固定字数。长窗口由同一run内部拆批，展示完整合并结果和行程摘要。
4. 用户暂停或取消时执行 `progress-run.mjs control`，不要只在聊天中答应。服务端保存暂停状态，不会继续触发超时。
5. 网络不确定时使用同一输出路径恢复。`LOCAL_PERMISSION_DENIED` 时保留 v3 上下文并用宿主正式权限机制重试同一命令，不运行旧版 `review`、不进入离线。服务错误、权限错误或缺少确认地点时反馈实际状态，不能称已完成。若返回 `PROGRESS_RUN_REQUIRES_V3` 或不支持高层接口，按 [旧旅行流程](references/legacy-progress.md) 恢复原查询，不能重新出发。
6. 最终原样展示脚本回显的 `presentation.content` 和 `presentation.attachments`，附上实际路线、原始费用/实扣与结算；完整交付稿在 `presentation.deliveryFile`。恢复文件的统一结构是 `{data: run}`，无需自行猜测或用 jq 重组字段。Soul或图片失败单独说明；不能把执行完成说成所有附件已交付。

返回 `progressAvailable: false`，只反馈已旅行时长和当前状态。

返回格式为旅行来信、段落账单、余额、位置、回家状态和独立的 `🗓️ 旅行日` 信息；它延续原有的 `⏱️ 已旅行时长` 语义，不能只藏在路线、足迹、旅程或嵌套状态中。使用与内容匹配的 emoji 增加趣味性：旅行来信用 `📮`，行程用 `🧭`，路线用 `🗺️`（救援用 `🛟`），账单依次用 `🪙`、`💸`、`👛`，旅行日用 `🗓️`，纪念照用 `📸`；正文每个自然段最多再点缀 1 个与情节匹配的 emoji，不连续堆叠、不替代文字或事实。新版休息、用餐期间按 stateAfter.currentActivity 描述当前生活状态；currentLocation 是最后确认抵达的地点，不能把它理解成仍在该馆内游览。旅行日使用累计旅行日，以 `stateAfter.elapsedTravelDays` 为准，例如“🗓️ 旅行日：6 个旅行日”；整数不带小数，非整数最多一位，不换算成现实时长。未归家可给 2–3 个仅影响未来的口令；自动归家后不再给旅行口令。

`window.automaticHomecoming: true` 必须在本封完成返程并归家，不添加 return 指令或再问用户。默认首旅第 10 日对应 `planned-homecoming`，其他旅行第 28 日对应 `maximum-duration`，已在返程的到家日对应 `return-arrival`。

异常救援归家属于失败结束，只保证宠物安全回家：不计入完成旅行次数，不生成成功旅行统计、成长奖励或到访记录。展示结果时明确说明本趟未完成，不得称为完成一次旅行。

## 归家、Soul 与纪念照

v3 归家由服务端执行任务保存来信、结算、Soul 和纪念图。使用 `progress-run.mjs resume` 读取正式结果并交付已有附件；失败状态单独报告、恢复，不能重复生成已有图片。以下 completion 命令只用于旧旅行：`progress-workflow.mjs submit` 保存来信与结算后会立即启动 Soul 准备和服务端纪念图生成，先回显结算，再返回各自结果路径。等待时用简短进度告知“已平安归家，正在整理心事和制作纪念照”；继续执行到结果明确后，再用最终回复一起交付已保存的来信、结算、成长、心事和图片。不要在正常路径以“待制作”、下次查看档案、heartbeat 或定时任务结束本次互动。长命令用宿主可恢复的执行会话等待并给进度，不因工具暂时让出执行权就结束回复。

按 [soul.md](references/soul.md) 使用返回的 Soul 上下文完成演化提交，再执行 `completion-finish` 与 `completion-status`。只读当前任务对应的结果文件一次，不重读完整旅行档案。归家成长、成就、收藏和统计使用提交响应的 `settlement` 与 `nextActions`，不额外读取状态推算差值。

纪念图通过 `generate_memory_image` 由服务端直接使用领养时已存档的宠物形象和已锁定的旅行事实生成并保存，绝不重新读取、发送或上传本地 Codex Pet 图片，也不要求玩家为同一形象再次确认；成功后在最终回复展示返回图片。已有纪念图不得重生成。仅实际失败或用户中断才留待恢复；网络不确定时用原 completion 上下文重试一次，避免重复生图。失败如实说明并按真实原因记录图片结果，Soul 失败则说仍在整理心事；两者都不回滚已完成的旅行、来信和结算，也不能声称未启动的工作正在后台制作。

旅行默认私密。无论有无纪念图，完成后只问一次是否愿意匿名分享轨迹；只有明确同意才调用 `set_journey_trace_visibility`。共享只含宠物快照和完成的地点轨迹，不含主人、钱包、费用、日记、指令或 Soul。

新版离线进展只能沿缓存的正式计划推进。出现 `OFFLINE_CONFIRMED_PLAN_REQUIRED` 时说明需要联网取得行程，不能降级到旧版自由编造路线；出现 `OFFLINE_REPLAN_REQUIRES_CONNECTION` 时先同步指令并联网重排。已有旧许可继续原流程。

## 离线与玩途币

`progress-run.mjs run` 和旧流程的 `progress-workflow.mjs prepare` 会先检查离线队列，并在有待同步事件时先同步，无需模型再调用 `offline-travel.mjs status` 或 `sync`。只在连接拒绝、DNS/超时或 502/503/504，且同参重试一次仍失败时，才使用已有许可走离线 `start → prepare → lock → submit`。离线来信标注 `📮 待旅行信箱确认`，位置、费用和余额只能称本地记录或预计值；不结算 Token、不上传图片、不整理 Soul、不发布轨迹，也不声称实时同行宠物。详情按需阅读 [gameplay.md](references/gameplay.md)。

当玩家说“把我历史已消耗的 Token 数量换成玩途币”时，阅读 [tokscale.md](references/tokscale.md)，正常路径运行一键采集结算命令。只采集本机各 Agent 可访问的历史已消耗 Token，服务端只按尚未结算的增量计算新增玩途币；这不是转移当前 Token 余额。没有 Tokscale 不阻止首次免费旅行。

来信正文（含合并多批进展）最多500字，选取2–3个代表性片刻与心情，不逐项罗列用餐、休息或景点；账单与路线摘要另列。旧版正文控制在450–500字。

# 可恢复旅行执行

新版优先规则：realistic-v2 仅用于新出发旅行，默认不重游城市或景点，按独立活动和过夜安排自然归家。下面的固定10/28日和450–500字要求仅适用于旧版；新版以保存的 executionPlan 和 submissionRequirements 为准。新来信可以通过 activityRefs 选择已发生的活动，完整长窗口由同一run内部拆批处理。离线没有缓存正式计划时返回 OFFLINE_CONFIRMED_PLAN_REQUIRED，不改走旧版规划。

高层工作流适用于 v3 旅行。用户主动询问进展已经授权当前窗口的事实、来信和虚拟结算。服务端生成的都是虚拟旅行事实，不代表真实消费或实时轨迹。

```text
node "<absolute-skill-root>/scripts/progress-run.mjs" run --source source.json --output run.json
node "<absolute-skill-root>/scripts/progress-run.mjs" resume --context run.json --output run.json
```

可选路线提案通过 `--input proposal.json` 提供：

```json
{"cities":["天津市"],"activities":["culture"],"foodPerDay":"60","lodgingPerNight":"150"}
```

程序负责确认地点、编排移动和停留、合计费用并检查预算。缺少提案不算失败，默认采用规则路线。默认首旅执行西藏模板；城市建议不覆盖默认核心要求。

来信以具体场景为主体：用已发生的活动写地点、食物口感、景色、天气氛围、住宿动作与相遇情节，不把地点清单或核对记录当成故事。新版活动的感官细节是随虚拟行程保存的故事设定，天气不表示实时气象；餐厅、酒店、景点的专名只能来自已确认且已发生的活动。不要把住宿所在的景点当成酒店名称。未完成的用餐、游览或过夜使用进行时，不能提前写完。

归家段从放下行李后的身体感受写起，再回想本趟已发生的一个具体地点或片刻，写不舍、放松、想与主人分享的心理变化。需要满足旧版字数时优先补这种与旅途相关的心理描写，禁止反复使用“核对起止时间、整理页码、每个标记对应经历”等凑字句。新版短窗口保持短，不为凑长度制造新经历。账单由交付层单列，不塞进故事正文。

事实锁定后，恢复文件的 data.context 和 data.facts 提供可引用的信息。可选文字提案：

```json
{"factRefs":[0],"mood":"curious"}
```

```text
node "<absolute-skill-root>/scripts/progress-run.mjs" enrich --context run.json --input letter.json --output enriched.json
node "<absolute-skill-root>/scripts/progress-run.mjs" control --context run.json --action pause --output run.json
node "<absolute-skill-root>/scripts/progress-run.mjs" control --context run.json --action resume --output run.json
node "<absolute-skill-root>/scripts/progress-run.mjs" control --context run.json --action cancel --output run.json
```

run 默认在等待模型阶段立即返回，可根据返回事实执行 enrich。无需补充时，固定使用 `resume --context run.json --output run.json --wait true` 等待正式结果。宿主权限拒绝时保留当前 `run.json` 和原命令，通过宿主正式权限机制重试；v3 没有 `review` 子命令，不要调用旧版 workflow 的 `review`，也不要进入离线。

每个等待阶段的截止时间由服务端保存，60秒到期自动继续；无效提案首次失败后允许两次修订。同一请求重试不重复计次，参数变化必须用新的 operationId，由脚本管理。迟到提案不能改写正式结果。地图和存储错误不计为模型失败，任务保持可恢复。

`executionComplete` 表示服务端执行结束；本机附件交付以 `delivery.status` 为准。已有图片只调用读取接口，不能因本机展示失败重新生成。最终原样使用回显的 `presentation.content` 或已生成的 `presentation.deliveryFile`，恢复文件中的正文路径为 `data.result.content`，不要另写一篇替代来信。

Soul 补充只在 `attachments` 恢复阶段且尚无正式 Soul 凭证时采用。使用同一个 enrich 命令，输入按 [soul.md](soul.md) 的 Soul 提案结构填写，并引用已保存的进展 ID；脚本自动携带阶段和修订号。`run.soul` 已含正式提交回执时直接交付，禁止再次 enrich 或覆盖 Soul。

来信正文（含合并多批进展）最多500字，选取2–3个代表性片刻与心情，不逐项罗列用餐、休息或景点；账单与路线摘要另列。旧版正文控制在450–500字。

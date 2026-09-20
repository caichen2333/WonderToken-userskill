# 程序管理的领养准备

家园精确定位是生成确认档案的前置条件。不能用网页搜索替代高德，也不能把用户输入的村名直接当成已确认家园。普通调用仍通过 `client.mjs call`；业务 JSON 写文件，身份由客户端管理。

## 准备档案

选择官方形象或导入自定义形象后，调用 `prepare_pet_adoption`，提供唯一 `operationId`、`name`、`heightCm`、`personality`、`visual`，以及可选的 `homeQuery` 和用于缩小范围的 `city`。首次不传 `expectedRevision`；修改必须传上次返回的 `revision` 作为 `expectedRevision`，并重新提供完整档案。修改会清除之前的家园选择并使旧卡失效。

形象参数仍为 `{source: "official", assetId}` 或 `{source: "upload", uploadId}`，禁止使用未导入的自定义 avatarId。准备流程不会创建宠物，也不会开始旅行。

## 按返回状态继续

| status | 行为 |
| --- | --- |
| `home-required` | 没有地名或没有匹配结果；向玩家补充地名、省市区，再更新准备。不展示确认卡。 |
| `home-selection-required` | 展示返回的候选名称、省市区、地址，由玩家选择。不得默认选第一项，不得声称已定位。 |
| `ready` | 只使用返回的 `card` 展示档案，包括完整家园地点。说明首次免费及身份锁定规则，等待玩家确认或明确出发。 |
| `created` | 宠物已创建，可按既有出发授权继续；不要重复准备。 |

多候选时调用 `select_pet_adoption_home`，提供唯一 `operationId`、`preparationId`、最新 `expectedRevision` 和玩家选中的 `placeId`。这里只接受本次准备记录中的候选，不接收手写地点对象。选中后使用新返回的版本和确认卡。只有一个高德候选时，程序直接返回 `ready`，玩家仍需通过档案卡核对家园。

## 最终创建和恢复

玩家确认已展示的具体档案后，调用 `create_pet`，仅提供 `operationId`、`preparationId`、`expectedRevision`、`profileConfirmed: true` 和 `visualConfirmed: true`。不再提供 name、home、visual 等档案内容。明确的“出发吧”可同时授权确认档案、创建和出发，不增设重复确认。

中断或版本冲突时调用 `get_pet_adoption` 获取服务端最新状态；`draftProfile`、`homeQuery` 和 `city` 可用于恢复后更新准备，不能当成确认卡展示。`STALE_ADOPTION_PREPARATION` 表示旧卡失效，不能只替换版本号继续创建；应展示最新卡，并确认它与玩家已确认内容一致。网络不确定的同一调用使用原 operationId 和原参数重试。程序持久化准备状态，并将宠物、Soul 初始档案和准备记录的完成状态一起保存。

旧接口不支持此流程时说明需要更新服务，不绕过准备步骤。不要向玩家暴露内部标识或版本号。

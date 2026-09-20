# 稳定调用速查

先设置 `SKILL_ROOT` 为当前已加载 WonderToken skill 的绝对目录。所有示例中的 JSON 文件都用文件工具或 JSON 序列化器创建，不用 `echo`、shell 插值或手写转义。

## 无参数读取

以下命令不需要 stdin、`--input` 或 `--json`：

```text
node "$SKILL_ROOT/scripts/client.mjs" call get_game_state
node "$SKILL_ROOT/scripts/client.mjs" call get_pet_soul
node "$SKILL_ROOT/scripts/client.mjs" call get_game_config
node "$SKILL_ROOT/scripts/client.mjs" call get_travel_footprints
node "$SKILL_ROOT/scripts/client.mjs" call get_journey_timeline
node "$SKILL_ROOT/scripts/client.mjs" call get_journey_archive
```

不确定命令行参数时运行 `node "$SKILL_ROOT/scripts/client.mjs" --help`。不确定某个业务工具的输入时才运行 `tools --compact TOOL`。不要读取完整 schema。

## 有参数调用

把输入保存为私有临时 JSON 文件，再运行：

```text
node "$SKILL_ROOT/scripts/client.mjs" call TOOL --input request.json --output result.json --compact
```

常见最小输入：

```json
{"query":"拉萨","includeDormant":true}
{"kind":"achievement","limit":20}
{"cursor":"上一页原样返回的 cursor","limit":20}
```

深层 Soul 查询使用 `{"query":"拉萨","includeDormant":true}`。Soul 管理必须先用 `{"view":"manage"}` 调用 `get_pet_soul`，再从该次响应读取 `expectedRevision` 和目标条目 ID；具体 action 结构只从 `client.mjs tools --compact manage_pet_soul` 读取，不能猜。

读取已有纪念图是只读操作：从紧邻的完成结果或档案响应取得 `journeyId`，保存 `{"journeyId":"..."}` 后调用 `get_memory_image`。不得因此调用 `generate_memory_image`、推进旅行、结算、整理 Soul 或询问分享。本机附件保存失败可用同一 `journeyId` 再读一次；服务端记录为生成失败时如实说明，不重新生成。

分享或撤销只针对已完成旅行：保存 `{"operationId":"...","journeyId":"来自完成结果或档案","enabled":true}` 调用 `set_journey_trace_visibility`；撤销时仅将 `enabled` 改为 `false` 并使用新的 operation ID。撤销只阻止未来匹配，不删除已经锁定的相遇。网络结果不确定时复用原文件和原 operation ID。

领养、出发、指令、Soul 管理和分享需要的 `operationId` 每次新操作生成一次；网络结果不确定时复用原请求文件及同一个 ID。`preparationId`、`expectedRevision`、`journeyId`、Soul 条目 ID 和分页 cursor 只能取自紧邻的服务响应，不能猜测或从旧档案拼装。

## 错误路由

| 返回 | 下一步 |
| --- | --- |
| `INVALID_CLIENT_OPTION` / `EMPTY_JSON_INPUT` / `INVALID_JSON_INPUT` | 按错误中的 usage 修正本地命令；业务请求尚未发送。 |
| `LOCAL_PERMISSION_DENIED` + `request_host_permission` | 保留 v3 的 `run.json` 或当前业务输入，用宿主正式权限机制重试同一命令；不运行旧版 `review`，不诊断为服务宕机，不进入离线。 |
| `check_connection` | 核对地址和网络并原样重试一次；只有 Skill 定义的网络故障才检查已有离线许可。 |
| 业务错误、余额不足、地点无效、版本冲突 | 按业务原因停止或读取最新状态；不切换身份、旧流程或离线流程。 |
| 附件失败 | 保留已完成的旅行与结算，只恢复附件读取；已有图片不得重生成。 |

## 进展入口

v3 正常入口固定为：

```text
node "$SKILL_ROOT/scripts/progress-run.mjs" run --source source.json --output run.json
node "$SKILL_ROOT/scripts/progress-run.mjs" resume --context run.json --output run.json --wait true
```

只在 `progress-run` 明确报告协议不支持时进入 `legacy-progress.md`。等待、权限、网络、地图、余额或提案校验失败都不是切换旧流程的理由。

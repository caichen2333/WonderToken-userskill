# Tokscale 全来源采集

WonderToken 将本机各 Agent 可访问的**历史已消耗 Token 数量**换算为玩途币，不转移当前 Token 余额。它调用固定版本 Tokscale 4.14.0，读取其在本机实际可访问的全部来源。安装 WonderToken 的宿主不限制采集范围：Codex 中可采集 Claude Code、OpenCode 等来源，反之亦然。只使用 Tokscale，不自行解析日志。

正常结算只运行一次，并让脚本保存完整快照和结算结果：

```text
node "<absolute-skill-root>/scripts/tokscale-snapshot.mjs" --settle --output "<private-temp>/settlement.json"
```

脚本在一次执行中检查固定版本、采集、保存 `<output>.request.json` 并调用 `settle_usage`，终端只回显来源和紧凑结算结果。仅排障时分别运行 `--check` 或 `--collect`，不要在正常路径拆成额外模型回合。

网络结果不确定时，不重新采集；将已保存的 `<output>.request.json` 原样作为 `client.mjs call settle_usage --input` 的输入重试。

需要下载时脚本会在联网前返回授权要求；先说明会由 npm 下载固定版本 Tokscale 并获得授权，再对同一命令添加 `--allow-download`。无需管理员权限或后台服务。依赖 Node 24.14+（24 LTS）及 npm；没有运行时时按 onboarding.md 指引安装，不再使用平台专属 Bun 安装脚本。

采集使用 `models --json --group-by client,provider,model`，不设置宿主 client 过滤。v2 snapshot 按 client 汇总五类 Token，再传给 `settle_usage`；完整快照不可修改。脚本拒绝无效来源、危险整数、负数、错误 JSON 和完全没有来源的数据。零 Token 条目可以正常结算为零，不等于采集失败。

只有来源级汇总、采集器版本、时间和哈希离开机器；提示词、对话、原始日志、路径和逐会话明细不上传。只展示实际发现的来源，不能把未发现来源称为“零使用”。部分来源需要先通过 Tokscale 登录/同步；按其官方固定版本说明提供步骤，不擅自读取凭据或登录第三方。

服务端对每个来源保存累计加权额度最高值，合并后统一取整，只有超过累计已发额度的历史使用增量才新增玩途币。同一系统用户在不同 Agent 重复采集、来源暂时缺失或恢复均不重复领取历史额度。重试提交同一快照，读取服务端保存的结算回执；不要将 replayed 回执中的历史 delta 说成这次再次入账。

首次免费旅行不要求 Tokscale 就绪。安装失败停止重试，说明修复步骤，不改写任何 Agent 的会话文件。

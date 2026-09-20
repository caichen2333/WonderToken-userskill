# 宠物档案与形象

领养档案必须按 [adoption.md](adoption.md) 先准备、定位家园、必要时选择候选，再展示程序返回的确认卡；形象导入不代表建档完成。

第一次出发锁定名字、5–500 厘米整数身高、1–3 个性格词、家园与固定形象。出发前可修改；出发后本版本无改名/换形象/搬家卡。不要询问或推断物种；玩途名字由玩家另取，不自动复制宿主宠物名。

六个官方形象是 Skill 内置图片，不依赖任何图片生成能力。每次首次领养或补全缺失形象时，必须先运行 `node "<absolute-skill-root>/scripts/pet-options.mjs"`，展示返回的全部六个 `official` 图片，并逐项说明 `custom.status` 与候选；不得直接手写候选、单独调用 discover 或因模型/思考模式而跳过。之后才按 [capabilities.md](capabilities.md) 发现照片定制能力；无论照片定制是否可用，官方六选项始终保留。

| assetId | 形象 |
| --- | --- |
| shiba | 柴犬，温暖好奇 |
| corgi | 柯基，热情可靠 |
| orange-cat | 橘猫，从容贪吃 |
| black-cat | 黑猫，安静机敏 |
| lop-rabbit | 垂耳兔，温柔细心 |
| little-fox | 小狐狸，聪明勇敢 |

图片位于 `<absolute-skill-root>/assets/pets/<assetId>.png`。宿主能展示图片时提供预览；无法展示时给出名字与文字描述。选中后在 `prepare_pet_adoption.visual` 传 `{ "source": "official", "assetId": "..." }`，无需生图或上传。

## 可选宿主扩展：Codex Pet 导入

这一节只适用于实际提供 Codex Pet 数据的宿主，是对开放 Agent Skill 的可选增强；其他宿主跳过该分支，不要求安装 Codex、读取其目录或模拟该能力。`pet-options.mjs` 已在当前宿主为 Codex 时完成一次自定义宠物发现，不再重复扫描。状态必须明确告知玩家：`found` 表示发现一个可选形象，`selection-required` 表示发现多个并须选择，`none` 表示未发现，`scan-failed` 表示扫描失败且官方六选项仍可用。底层兼容命令为：

```text
node "<absolute-skill-root>/scripts/pet-visual.mjs" discover
```

`discover` 退出码 3 是正常业务结果，表示未发现或需要从多个候选中选择；必须解析标准输出，不能当成脚本异常。发现一个或多个自定义形象时，展示候选供玩家选择；不要提前导入或锁定，不隐藏官方形象。用户明确选择后执行 `pet-visual.mjs import "<avatarId>"`，将返回的 uploadId 以 `{ "source": "upload", "uploadId": "..." }` 传给服务端。旧 source: codex 仍兼容。禁止把 avatarId 当成 uploadId。领养时将形象选择交给 `prepare_pet_adoption`，`create_pet` 只接受准备记录引用。未发现或无法读取时回到官方形象，不重复扫描。其他 Agent 不要求安装或读取 Codex。

导入成功后优先用返回的 `attachments[].path` 绝对路径展示实际导入形象，不将 `image.url` 当作已经交付的预览。已导入但缺少预览时，调用 `client.mjs call get_pet_visual_image` 并传原 uploadId 获取图片附件，不重复 import。`preview.status: unavailable` 只表示预览未交付，保留 uploadId 并说明具体原因；旧服务不支持该工具时需更新服务。远程地址可能带有 OSS 强制下载响应头，不能把图片上传成功等同于对话预览成功。

## 照片定制（能力可用时）

先说明玩家可以上传清晰宠物照片，再检查可见毛色、花纹、脸、耳、尾巴与体态。用图片工具或相关 Skill 参考照片生成一张全身、单角色、统一二维动漫旅行绘本形象，简单浅色背景；保留辨识特征，不添加文字、标志、其他动物或未要求的饰物。

展示真实生成结果供用户确认；首次出发前可按其要求调整。确认后保存 PNG/JPEG/WebP，运行：

```text
node "<absolute-skill-root>/scripts/media-upload.mjs" pet --file "<absolute-image-path>" --display-name "<展示名>" --description "<可见外观描述>"
```

以 source: upload 和 uploadId 准备领养档案，或修改已有宠物形象。脚本只上传二进制，不要求用户粘贴身份密钥。读图、生图或上传失败时说明真实原因并返回官方形象或可用宿主宠物候选；不调用服务端生图兜底。

# dsh-cost-meter

> **DeepSeek Harness（DSH）插件**：在输入框信息栏显示**本轮 / 会话成本**，内置 DeepSeek 官方峰谷价目表，点开可看按计费项拆分的明细与今日消费。
>
> A composer-dock cost meter for DeepSeek Harness: per-turn and per-session spend priced with DeepSeek's official peak / off-peak rates, plus today's usage breakdown.

<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-cost-meter icon">
</p>

## 功能

信息栏在「Token 用量」右侧增加一枚金额标记，点击打开双栏明细：

```
（图标）¥0.236 · ¥2.355          ← 本轮成本 · 会话成本
```

```
（图标）本轮成本 ¥0.2360                     会话成本 ¥2.3549
─────────────────────────────────────────────────────────
            本轮        会话  │        会话      总计
输入支出 ¥0.008     ¥0.255  │ 对话轮数     4 轮   23 轮
缓存支出 ¥0.104     ¥1.362  │ 今日支出  ¥2.791  ¥8.104
输出支出 ¥0.029     ¥1.173  │ 总计支出  ¥2.791  ¥8.104
─────────────────────────────────────────────────────────
本会话缓存命中率 99.6%                  本会话缓存节省 ¥66.757
deepseek-flash 空闲价 · 输入 1.00 · 缓存 0.02 · 输出 4.00
```

- **表头**：本轮成本 / 会话成本，保留 4 位小数。
- **左表**：按计费项拆账（输入 / 缓存 / 输出支出），对比「本轮」与「会话」。
- **右表**：对话轮数 / 今日支出 / 总计支出，对比「会话」与「总计（本机全部会话）」；
  总计列保留 **4 位有效数字**，避免大额时出现一长串无意义小数。
- **底注**：本会话缓存命中率、本会话缓存节省（相对未命中缓存价的估算节省）。
- **页脚**：当前模型与当段单价（2 位小数），并标注「空闲价 / 高峰价」。

## 计价方式

- **Token 来源**：会话日志里每次模型调用结算的用量（`assistant/message.usage`）。折账方式与 DSH 自身的
  `tokenUsage` 会话投影一致：同一步内后续样本替换前一样本，`llm/retry-started` 之后的样本重新累计，
  因此金额与信息栏旁的 token 数字始终同源。
- **金额 = Token × 单价，是估算而不是账单**：Harness 只记录 Token，不记录金额。
- **峰谷计价**：DeepSeek 高峰时段为北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00，
  高峰价为空闲价的 2 倍。插件按**每条消息结算时的时间**取当时单价，跨过 9:00 / 18:00 / 节假日边界的
  一轮会分段计价。法定节假日按 `prices.json` 里的 `holidays` 判定。
- **「今日」**按运行 DSH 的主机本地时区划分自然日；**「总计」**覆盖本机 DSH 的所有会话
  （含子代理会话，以及从持久化日志回填的历史会话）。
- 插件只读会话数据：不改写会话日志、不修改模型请求、不发额外模型调用。

## 安装

本插件以「本地包目录」形式安装，未发布到 npm：

```bash
git clone https://github.com/WhXcjm/dsh-cost-meter.git
```

然后在 DSH 中安装该目录：设置 → 插件（Plugins）页添加本地包，或让 Agent 使用 `plugin_manager` 的
`install_bundle`，目标指向克隆下来的目录。安装完成后重载插件（或重启 DSH），信息栏即可看到金额标记。

> 依赖：DSH 桌面 / Web 组合（含 `sessions`、`sessionPersistence`、`connection` 服务）。
> 插件通过已认证的 `/api` 通道暴露只读快照，不新增端口。

## 配置

`cordis.patch.yml` 暴露界面相关设置：

```yaml
- insert:
    - id: cost-meter
      name: 'dsh-cost-meter'
      config:
        currency: '¥'      # 金额符号
        dailyBudget: 0      # 今日预算；>0 时面板出现预算进度行
```

其他可选项：`coldScanBudgetMs`（历史会话回填的单次时间片）、`coldScanIntervalMs`（回填刷新间隔）。

## 价格表 `prices.json`

官方价目表单独维护，**修改后数秒内热加载，无需重启或重装**。
文件附带 `source`（官方页面）、`retrievedAt`（抄录日期）、`peakMultiplier`、`peakWindows`、
`peakOffsetMinutes`、`holidays`。当前抄录值（2026-11-01，单位：元 / 百万 tokens）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-flash（DeepSeek-V4.1-Flash-1017）· 空闲 | ¥0.02 | ¥1.00 | ¥4.00 |
| deepseek-flash · 高峰 | ¥0.04 | ¥2.00 | ¥8.00 |
| deepseek-v4-pro · 空闲 | ¥0.15 | ¥4.50 | ¥13.50 |
| deepseek-v4-pro · 高峰 | ¥0.30 | ¥9.00 | ¥27.00 |

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
节假日依据 [国务院办公厅 2026 年部分节假日安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)；
次年放假安排公布后，把新日期补进 `holidays` 即可。

## 目录结构

```
dsh-cost-meter/
├── index.js            Host 半：增量折账、跨会话聚合、/api/cost-meter/snapshot
├── client.js           Client 半：信息栏 pill 与双栏弹层
├── prices.json         官方价目表（可热加载）
├── cordis.patch.yml    bundle 补丁与配置
├── locale/             插件管理器显示的标题/说明（中/英）
├── icon.svg            插件图标
└── design/             图标候选图（SVG / PNG）
```

Host 半使用 `ctx.sessions` 读取实时会话、`ctx.sessionPersistence` 回填历史会话，
通过 `ctx.connection.fetch` 注册只读路由；Client 半向 `conversation.composer.dock`
注册 `id: cost`（`order: 2`）的条目，文案走 `cost-meter` 本地化命名空间。

## 开发

- 无构建步骤：Host 为普通 ESM；Client 为 `window.__ModuleLoader__` 浏览器 bundle。
- Client 半改动会热替换；Host 半改动需重载插件或重启 DSH；`prices.json` 改动即时生效。
- 折账逻辑曾与 DSH 自身 `tokenUsage` / `sessionStats` 投影逐位比对，并对空闲 / 高峰 /
  午休 / 周末 / 法定节假日 / 跨时段混排做过单测。

## 第三方资源

- 信息栏图标：[Heroicons](https://heroicons.com) `banknotes`（MIT）。
- 插件图标：原创。
- 图标候选图内的图标：Lucide（ISC）、Tabler（MIT）、Phosphor（MIT）、Remix Icon（Apache-2.0）、
  Material Symbols（Apache-2.0）、Heroicons（MIT）。
- 价格数据：DeepSeek 官方文档（事实性数据），已注明来源与抄录日期。

## License

[MIT](LICENSE)

# 定价目录（pricing catalog）

AIUsage 把所有模型定价数据集中维护在 **`@aiusage/shared/pricing`**，CLI 端与 Worker 端共用同一份；两端不再有独立副本。

## Pricing Truth 规则

- **Token facts are immutable. Pricing is versioned. Cost is derived.** 重算费用不得修改任何 token、event 或 session 字段。
- scanner 上报的 provider/product 是 raw reporting identity，保留用于统计；`normalizePricingIdentity()` 只为 catalog lookup 生成 canonical pricing identity。例如 `openai-codex/pi` → `openai/codex`，`xai/pi` → `xai/grok-build`。模型 namespace 不会因为看起来相似而删除；必须由官方路由说明或逐条 alias 明确证明等价。
- Worker 的 `/api/v1/public/pricing` 是当前服务端 authority。CLI 在存在 target 时优先请求该 Worker；cache 只在网络失败时 fallback，且旧于 bundled catalog 时会被忽略并显示 warning。
- CLI report 输出 `Pricing source`、`Pricing version`；cache fallback 还输出 `fetchedAt`。Worker ingest 将供应商实际费用与客户端原始估算分开保存；目录估算仍由 Worker 调用 shared catalog 统一计算。
- catalog 没有可靠的历史 effective price 时间轴时，历史费用语义是 **Current Catalog Revaluation**：按当前 catalog 估算历史 API-equivalent cost，不声称还原发生日真实账单。

`cost_status` 描述单价匹配和计算精度，`cost_source` 描述金额来源。`exact` 只表示 token 档位与已知 SKU 能按规则计算，不能表示供应商账单已核对。

```
packages/shared/src/pricing/
├── types.ts          # ModelPricing / PricingTier / PricingCatalog 等类型
├── catalog.ts        # 总目录：version + fx + aliases + providers
├── identity.ts       # raw identity → canonical pricing identity
├── version.ts        # 非 semver pricing version 的日期比较
├── calculate.ts      # calculateCost / getWorstCostStatus
├── index.ts          # 对外导出
└── data/
    ├── anthropic.ts
    ├── openai.ts
    ├── google.ts
    ├── moonshot.ts      (Kimi K2.x / Moonshot V1)
    ├── alibaba.ts       (Qwen / 通义千问)
    ├── deepseek.ts
    ├── zhipu.ts         (GLM)
    ├── github.ts        (Copilot — 影子价)
    ├── sourcegraph.ts   (Amp — 影子价)
    ├── xai.ts           (Grok Build — 影子价 / force_estimated)
    └── placeholders.ts  (inflection / cursor / droid / opencode — 空表)
```

## 范围约定

按维护成本与影响面分三档：

| 档位 | 范围 | 维护责任 |
| --- | --- | --- |
| **核心** | scanner 实际采集的 provider/product + 该 provider 最近 12 个月主力模型 | 必须保证准确，由 maintainer 定期核对 |
| **扩展** | 主流 provider 全部历史模型 + 主流中文模型（Kimi / Qwen / DeepSeek / GLM） | 社区 PR best-effort，发现错误即修 |
| **不收** | EOL > 1 年的模型；同一模型多 region 价差；私有部署 / 套餐价 | 显式拒绝 |

## 数据字段

`ModelPricing` 关键字段（详见 `types.ts`）：

| 字段 | 说明 |
| --- | --- |
| `currency: 'USD' \| 'CNY'` | 价格币种。Worker 端结算时按 `catalog.fx` 折算到 USD |
| `input_per_million` / `output_per_million` | 基础单价 / 1M tokens |
| `cached_input_per_million` | cache hit 价（Anthropic 叫 cache_read，Kimi 叫缓存命中） |
| `cache_write_per_million` | 通用 cache write 价（OpenAI GPT-6 / GPT-5.6 按未缓存 input × 1.25；Kimi 的缓存未命中按普通输入价） |
| `cache_write_5m_per_million` / `cache_write_1h_per_million` | Anthropic 风格 prompt caching write |
| `tiers?: PricingTier[]` | 阶梯定价：按 input token 数命中不同档位（Qwen / Gemini 2.5 Pro / GLM 等） |
| `effective_from` / `effective_to` | 价格生效区间（审计用） |
| `notes` | 备注（如 `deprecated`、`75% off promo until ...`） |
| `source_url` / `checked_at` | 单价来源与最近核对日期；新增价格必须填写 |
| `is_free` | 官方明确标注为免费；和缺价的 0 美元分开 |
| `force_estimated` | 已知单价仍缺少请求级峰谷、倍率等证据时，强制标为估算 |

## 别名 (aliases)

`catalog.aliases` 是**显式声明**的等价名映射，命中后视为 `exact`：

```ts
'claude-opus-4-7-20260201': 'claude-opus-4-7'  // 带日期后缀的版本号
'codex-auto-review': 'gpt-5.4'                  // 工具内部模型 → 实际推理模型
```

`alias` 与 **前缀回退** 是两种不同机制：

- alias 命中 → `costStatus: 'exact'`（你显式说"这两个名字等价"）
- 前缀回退（找不到精确匹配，按最长前缀降级到同 family 旧版本）→ `costStatus: 'estimated'`

若 provider/product 指向网关或订阅产品，目录不会自动套用底层模型厂商的单价。动态路由（例如 `group/cheap-first`）和未验证 namespace 保留用量并标为不可定价，直到拿到可靠的路由/账单证据。

## 折算汇率

`catalog.fx` 集中维护，避免散落到各文件：

```ts
fx: { CNY: 7.2 }  // 1 USD = N CNY
```

Worker 启动时可通过 env 覆盖（暂未实现，规划中）。

## 阶梯定价

`tiers` 数组按 input token 升序排列，命中条件是 `totalInputTokens <= threshold`；最后一档不写 threshold 表示 +∞：

```ts
tiers: [
  { threshold: 32_000,  input_per_million: 4,  output_per_million: 16 },
  { threshold: 128_000, input_per_million: 6,  output_per_million: 24 },
  { threshold: 256_000, input_per_million: 10, output_per_million: 40 },
  {                     input_per_million: 20, output_per_million: 200 },
]
```

> **限制**：Gemini 2.5 Flash 等模型还按 **output** 长度分档；GLM-4.7 同样有 input × output 双维度。当前实现只按 input 命中，output 分档暂用保守取低档（标了 `notes`）。

### OpenAI Codex 的长上下文与 cache write

GPT-6 Astra / Sol / Luna、GPT-6.1 Sol / Terra 与 GPT-5.6 系列单次 prompt input **> 272K** 时，整次请求按该 SKU 的长上下文档计费。长档倍率因模型而异，以目录条目和官方价格页为准。

新版 Codex JSONL 的 `payload.info.{last,total}_token_usage.cache_write_input_tokens` 会被 scanner 从普通 input 中拆出：

```text
total input
├── cached read   （cached_input_tokens / cache_read_input_tokens）
├── cache write   （cache_write_input_tokens）
└── normal uncached input
```

三者各自按 `cached_input_per_million` / `cache_write_per_million` / `input_per_million` 计费，不会重复计入；老日志缺失该字段时按 0 处理。

模型名后缀 `-fast` / `-priority` 会先剥离为基础模型再查**分开的**倍率表。请求级 `service_tier` 或明确模型后缀才算证据；Codex 当前 `config.toml` 不能反推历史请求等级。没有证据时按 standard 价估算。OpenAI 官方把 Fast mode 标为 2x 的 SKU 按该倍率计算；未登记 tier 使用 standard 价并标估算。Google Gemini 3.8 Flash Priority 按其公开的 1.8x 价格计算。

## 当前新增 SKU 与证据

价格版本为 `2026-11-18-current-catalog-v2`。新增/更新的条目在目录中记录 `source_url` 和 `checked_at: 2026-11-18`。

| 模型/来源 | 目录口径 | 可信度限制 |
| --- | --- | --- |
| GPT-6.1 Sol / Terra | OpenAI 当前 Standard、缓存命中、30 分钟缓存写入和 >272K 长上下文价 | Codex 本地日志没有缓存 TTL 时采用 30 分钟写入价；不代表账号真实账单 |
| DeepSeek V4.1 Flash / Pro | 当前峰值输入、缓存命中、输出价 | 峰谷时段费率相差 2 倍，本地记录未保留峰谷证据，所以按峰值估算；`deepseek-v4-flash` 等 legacy ID 仅因官方文档确认重定向才映射到 V4.1 Flash |
| Gemini 3.8 Flash | Gemini API 标准价：输入 `$0.75`、缓存 `$0.075`、输出/思考 `$3.75` 每百万 tokens | 当前优惠到 2026-12-31；API 价格不等同于 Google 应用订阅或 Antigravity 账单 |
| OpenCode `deepseek-v4.1-flash-free`、`glm-5.3-flash-free` | 官方目录明确标 Free，金额为 0、source 为 `explicit_free`；即使 scanner 的 provider 字段是 `deepseek` / `zhipu`，也只在 product=`opencode` 且 exact ID 命中时映射 | 只限这两个已确认 ID；其它 `*-free` 名字仍是未知 |

官方参考：[OpenAI API pricing](https://developers.openai.com/api/docs/pricing)、[OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)、[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)、[OpenCode Console models](https://opencode.ai/docs/console/models)。

## 2026-11-22 路由定价

`2026-11-22-route-pricing-v1` 收录 GPT-6.2 Sol/Astra 标准、长上下文和 Fast 费率，缓存写入估算采用 30 分钟费率。OpenCode Go 的 GPT-5.6 Luna、Claude Haiku 5.5 与 GLM-5.3 使用其订阅额度折算价，Z.AI 的 GLM-5.2 使用国际 API USD 价。Hy3 Free 仅在官方历史目录可核实的整日区间内匹配 OpenCode Zen 的确切 SKU。Gemini 3.8 Flash 的 Antigravity 内部变体保留各自身份。

[OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [OpenAI Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) · [OpenCode Go](https://opencode.ai/console/go) · [Z.AI](https://docs.z.ai/guides/overview/pricing) · [OpenCode Zen 历史文档](https://github.com/anomalyco/opencode/blob/a0f8dccbfe139ffc7137d1eaf6fee6e4195af599/packages/web/src/content/docs/zen.mdx)

## 金额来源与兼容

| `cost_source` | 含义 |
| --- | --- |
| `provider_actual` | 供应商/账户 API 明确返回的实际费用 |
| `client_estimate` | 客户端日志自己的估算；保留在 `reported_cost_usd` 供审计，不代替主费用 |
| `catalog_estimate` | Worker 用当前 shared catalog 计算 |
| `explicit_free` | 目录明确证实免费 |
| `unavailable` | 没有可信价格，金额 0 但不代表免费 |
| `legacy_unknown` | 旧行来源无法追溯，尚未安全重估 |
| `mixed` | 日汇总含多种来源 |

客户端可继续发送旧版 payload。只有显式标记 `provider_actual` 的金额会作为供应商实际费用；旧 `costUSD` 和未分类金额会保留为客户端估算证据，不会冒充供应商账单。旧 Codex 没有 output/reasoning 语义字段时按“output 已含 reasoning”处理。新客户端会发送互斥 token 桶、`costSource`、`costEvidence`、`costGranularity` 和 `outputTokensIncludesReasoning`。`costEvidence` 描述服务等级等证据，`costGranularity` 描述金额是按请求还是聚合 token 算出；有明确价格版本和逐请求粒度的目录费用在历史重估时保留原值及版本，缺乏粒度证据时只能按汇总值受限估算。部署新 Worker 前依序执行 `0006_cost_provenance.sql`、`0007_cost_recalculation_baseline.sql`、`0008_snapshot_completeness.sql`。

Overview API 和历史重估报告将 `cost_status=unavailable` 计入缺价，其余 `legacy_unknown` 计入来源未验证。已覆盖量含明确免费，可减去免费量获得已计价量。该诊断留在 API 和维护报告中，费用 KPI 显示主金额，客户端报告金额单列。快照完整度仍按设备和日期计算。

## 贡献新模型 / 修订单价

1. 找到对应 `packages/shared/src/pricing/data/<provider>.ts`，新增或更新条目
2. 价格务必从**官方文档**取，填写 `source_url`、`checked_at` 和必要的 `notes`
3. 已下架模型不要删除，仅在 `notes` 加 `deprecated` 标注（保证历史数据可重算）
4. 在 `catalog.ts` 的 `PRICING_VERSION` 升级价格版本，便于审计追溯
5. 跑 `corepack pnpm --filter @aiusage/shared test` —— CI 测试会校验关键模型可解析
6. 若新增 provider，记得在 `catalog.ts` 的 `providers` 与 `pricing.test.ts` 的 `required` 数组里同步登记

## 已知影子价（非真实结算价）

- **GitHub Copilot**（`github/copilot-cli`、`copilot-vscode`）按 "premium request" 套餐计费，不公开 per-token 单价。代码里的单价是按底层模型（OpenAI / Anthropic）官方价复制的"影子价"，仅作 token 用量估算
- **Sourcegraph Amp**（`sourcegraph/amp`）按打包月费 / 请求计费，同理

未来若有需要，可在 `ModelPricing` 加 `is_shadow_price: true`，让 calculateCost 自动把 `costStatus` 标为 `estimated`。

## 历史费用重算

历史 D1 重算由受保护的 maintenance script 执行，不暴露公开 API。命令使用仓库指定的 pnpm 10.6.5：

```bash
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --from 2026-01-01 --to 2026-01-31
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --apply --yes --backup-dir /secure/path/aiusage-backup
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --rollback /secure/path/aiusage-backup/aiusage-cost-backup.json --yes
```

脚本默认只读 dry-run，按设备/日期/模型列差额、覆盖率和未定价列表。`--apply --yes` 会先写入权限为 `0600` 的完整 D1 SQL 快照和带 SHA-256 的 JSON 金额备份，再按日期分批更新；只写金额、来源、状态、价格版本和 top-cost 字段。应用后校验 token/source facts 未变。相同输入重复 apply 收敛到同一费用值。

回滚使用 `--rollback PATH --yes`，只恢复费用字段并验证回滚结果。它会拒绝哈希错误的备份，也会在备份后出现新用量或原始计数变化时拒绝执行，以免覆盖之后的同步。回滚不会移除新行或改写 token facts；如果日期在 apply 后有新上传，应先对目标日期重新盘点并生成新的 dry-run/备份。

没有原始逐请求日志的汇总行只能按平均请求输入估档，无法恢复单次长上下文档、缓存写入 TTL、服务等级、DeepSeek 峰谷、动态路由和真实供应商账单。每台设备的历史目录、日志可用性和模型路由都必须按本机盘点独立评估，不应从其它设备推断路径或费用。

## 测试

- `corepack pnpm --filter @aiusage/shared test` — 校验关键模型可解析、阶梯命中、币种折算
- `corepack pnpm --filter @aiusage/worker test` — Worker 端 calculateCost 行为回归
- `corepack pnpm --filter @0verme/aiusage-cli test` — CLI report 集成测试

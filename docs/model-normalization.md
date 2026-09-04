# 模型名称与聚合审计

## 身份分层

AIUsage 不再把一个 `model` 字符串同时当作原始值、定价 SKU、聚合键和展示文案：

| 字段 | 用途 | 规则 |
| --- | --- | --- |
| `rawModel` | 数据源审计、回溯 | 保留 scanner 看到的原始模型名；兼容旧客户端时回退到 `model` |
| `pricingModelKey` | Pricing catalog lookup | 仅做定价所需的安全/显式归一化，不能用于 Dashboard 聚合 |
| `canonicalModel` | Dashboard 聚合 | 只做 trim、大小写、空格/下划线和重复连字符归一化；provider namespace 只拆 known prefix；高风险别名必须登记在 `MODEL_ALIASES` |
| `displayName` | UI 文案 | 从 `canonicalModel` 生成品牌化名称，不参与计算或筛选存储 |

`rawModel` 与 `pricingModelKey` 已加入 ingest 类型。D1 旧表无需迁移：历史行继续使用 `daily_usage_breakdown.model`，新 ingest 在 `extra_metrics_json.raw_models` / `extra_metrics_json.raw_model` 保留经过 pricing key 归一化的原始模型值；`model` 字段仍保持旧版 pricing-compatible 语义，避免破坏主键和历史定价重算。

费用先按 breakdown 的 `pricingModelKey`（旧数据则回退 `model`）计算，之后才按 `canonicalModel` 汇总。因此 alias 合并不会把一个价格 SKU 的费用套到另一个 SKU 上。

## Dashboard 开关

Dashboard 默认启用 **Merge model aliases**。关闭开关后：

- model share、model facet、Sankey 使用数据库中的 raw/pricing-compatible `model`；
- breakdown API 可通过 `mergeModelAliases=0` 查看未合并行；
- 开关只改变读取与展示聚合，不修改 D1 数据，也不改变 cost 计算。

API 也支持 `mergeModelAliases=0|false|off`；默认值为开启，便于兼容历史 Dashboard URL。

## 高风险别名策略

不得因为模型名相似就自动删除日期、版本或能力后缀。新增 alias 前应确认：

1. 两个名称确实表示同一个可计费 SKU；
2. Pricing catalog 不需要区分它们；
3. 加入 shared 的 `MODEL_ALIASES`，同时补充 `packages/shared/src/__tests__/model.test.ts`；
4. 检查 provider 前缀是否属于 `MODEL_PROVIDER_PREFIXES`，未知 `provider/model` 必须完整保留。

## Remaining Unknown Aliases

扫描本机日志中的模型名：

```bash
aiusage audit-models --range 1m --json
```

该命令输出：

- `safeVariants`：仅大小写、空格、下划线或重复分隔符不同的值；
- `knownAliases`：已经由 `MODEL_ALIASES` 明确登记的值；
- `remainingUnknownAliases`：疑似日期后缀、版本分隔符或未解释 canonical collision 的值，只报告、不自动合并。

`remainingUnknownAliases` 是人工审计清单，不是自动迁移建议。确认后逐条更新 alias map 和测试；不能直接把清单中的 `suggestedModel` 当作定价 key。

若要审计 D1（包括历史 ingest 行和 `extra_metrics_json` 中的 raw 值），使用只读脚本：

```bash
pnpm --filter @aiusage/worker db:audit-models --remote --from 2025-01-01 --to 2026-08-31
```

脚本只执行 `SELECT`，必须显式选择 `--remote` 或 `--local`，不会写入数据库。

## 当前线上数据审计样本

从 overview API 观察到的重复写法包括：

- `GLM-5.3-Flash` / `glm-5.3-flash`；
- `DeepSeek-V4-Flash-0731` / `deepseek-v4-flash`；
- `anthropic/claude-opus-4.8-coding`；
- `zai-org/glm-5.3`。

前三类分别由安全规范化、显式 DeepSeek alias 和 known provider prefix 处理；未知 provider namespace 不会被静默剥离。

# 计费来源与历史修复

## 一笔费用如何得出

`daily_usage_breakdown.estimated_cost_usd` 保存面向看板的主金额；`cost_status` 描述价格匹配/计算可信度，`cost_source` 描述金额从哪里来。二者不能互相替代。

| 来源 | 主金额处理 | 审计字段 |
| --- | --- | --- |
| 供应商实际费用 | 有明确 `provider_actual` 时保留 | `cost_source`, `pricing_version` |
| 客户端原始估算 | 不覆盖服务端主金额 | `reported_cost_usd`, `reported_cost_source` |
| 服务端目录估算 | Worker 调用 shared catalog 计算 | `cost_source=catalog_estimate`, `pricing_version`, `extra_metrics_json.cost_evidence` |
| 明确免费 | 主金额 0，仍计入已解释覆盖量 | `cost_source=explicit_free` |
| 无法定价 | 保留 tokens，主金额 0，列入待补价清单 | `cost_source=unavailable`, `cost_status=unavailable` |
| 旧数据来源未知 | 原金额保持，直到重估流程确认 | `cost_source=legacy_unknown` |

历史版本只有 `cost_status` 时没有可靠的费用来源证据。migration `0006_cost_provenance.sql` 会将这类行初始化为 `legacy_unknown`，看板将其算入未覆盖量，避免旧金额被误当成完整账单。Migration `0007_cost_recalculation_baseline.sql` 增加首次重估前的旧金额、状态、来源和价格版本字段；`0008_snapshot_completeness.sql` 将无法验证为完整的旧日快照标记为不完整。

## 新日志写入规则

- 常规 `aiusage sync --from ... --to ...` 扫描所有启用的工具；`sync --tool` 会拒绝。完整日期的每日行和 breakdown 在 D1 batch 中一起替换，同一设备同一天重复上传保持幂等。
- `aiusage import` 是明确的产品级部分导入。Worker 只替换 `productScope` 内的行，并从当天全部产品 breakdown 重新汇总；仅当 D1 已有完整基准日时才接受。migration `0008_snapshot_completeness.sql` 将旧行视为未验证，必须先完整 sync 一次；没有完整基准日时返回 `BASE_SNAPSHOT_MISSING`。
- 看板分开显示 token 计价覆盖率和设备/日期完整快照覆盖率。旧日期在 `0008` 默认是未验证；完整 sync 后才纳入完整快照比例。选择某个 provider/model 时，快照比例仍按当前设备和日期范围计算，因为完整性属于整日维度。
- output / reasoning 互斥规则按数据源定义。Codex 新 scanner 将原始 output 拆为不含 reasoning 的 output 与 reasoning 两桶，并额外记录 `source_output_tokens`；旧 Codex 行若没有语义标志，按原始 output 已含 reasoning 处理。其它供应商不做全局扣减。
- Pi 日志中的 `usage.cost` 保留为客户端原始估算，Worker 仍以共享目录计算主金额；这不能证明供应商实际扣费。
- Codex `sessions` 和 `archived_sessions` 中的 `.jsonl.zst` 现以流式方式纳入扫描和本地 all-history 报告。它们需要 Node 内置 Zstandard 支持（Node 22.15+ 或 23.8+）；压缩流无法读取时整次扫描失败，避免上传缺少归档记录的日快照。
- Fast / Priority 只能根据逐请求日志字段或显式模型 tier 计算。当前 `config.toml` 只描述当前配置，不能补写历史请求 tier。缺证据时以 standard 价作为 `estimated`，并留存 evidence。Codex scanner 还会标记 `costGranularity=per_request`；同版本目录重估保留它按单次长短上下文和请求 tier 累计的费用，避免再按聚合平均 input 估档。

## 优先用原始日志重放

原始日志可用时，通过新 CLI scanner 重建**完整日期快照**，而不是把 Codex 单工具结果上传成整天快照：

```bash
aiusage scan --from 2026-10-01 --to 2026-10-31 --json > /secure/path/scan-preview.json
aiusage sync --from 2026-10-01 --to 2026-10-31 --target production
```

先检查本地预览中的日期、工具覆盖和未知模型，再执行 sync。CLI 会重扫该设备所有启用的 scanner；任何必需 scanner 失败时不会上传该完整日期快照。不要将 `scan --tool codex` 结果包装成完整 sync。目标 `production` 必须是本机已配置且经确认的目标名。

原始重放能恢复 Codex 单请求长短上下文、日志里存在的 service tier、缓存拆分与当前 scanner 的 reasoning 语义；它仍不能还原供应商账单、日志未记录的 cache TTL、缺失的 request tier 或动态路由服务端最终模型。重放前应先保留数据库导出，避免 token facts 因 scanner 版本差异被覆盖。

如果受影响的行只有数据库汇总，没有本机对应日志，则走下方受限重估：按总量和平均单请求 input 估阶梯；不猜服务等级、cache TTL、峰谷或路由模型。

历史行若 `extra_metrics_json.raw_providers` 记录了多个来源，重算器会将其标为无法定价，不会按数组第一项或模型名称猜测一个路由价格。原始 provider 列表仍保留用于后续核查。

## 只读试算、分批应用和回滚

使用仓库指定 pnpm：

```bash
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --from 2026-10-01 --to 2026-10-31
```

默认只读。旧 D1 schema 也可预览：脚本用 `PRAGMA table_info` 发现列，缺失的来源字段按 `legacy_unknown` 处理，输出 `dataSchema=legacy-read-only-compatibility`。这是当前目录对旧汇总行的重估，不是发生日账单；旧 schema 下 `--apply` 会被拒绝。输出 `dataSchema=provenance-enabled` 且迁移 `0006-0008` 完成后，才具备应用条件。

检查 JSON 输出中的 `before` / `after`、`costDeltaUsd`、`coveragePercent`、`scopedCostChanges`（设备/日期/模型）和 `modelsStillUnavailable`。旧行来源未知会被计入重估前未覆盖量；重估后也应分别审查精确匹配、估算、明确免费和未定价模型。确认来源与定价假设后，再按月或更小日期窗分批应用：

若只修正指定设备、产品、模型和已记录路由，可重复传入 `--device`、`--product`、`--model`、`--raw-provider` 并同时限定开始和结束日期。指定 `--raw-provider` 时，只有日志元数据明确记录为单一路由的行会匹配；混合或缺失路由会保持原样。该模式只更新匹配 breakdown 的费用字段；对应日汇总会用整日原有 breakdown 金额加上目标行的新金额重新计算。回滚备份只保存目标费用行和受影响日汇总，但 token-facts 哈希覆盖受影响日期的全部 breakdown，检测同期新用量后会拒绝回滚。

```bash
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --from 2026-08-20 --to 2026-09-18 --device sakur --device jiasfn-pi --product pi --model gpt-5.6-luna --raw-provider openai-codex
```

```bash
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --from 2026-10-01 --to 2026-10-07
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --from 2026-10-01 --to 2026-10-07 --apply --yes --backup-dir /secure/path/aiusage-2026-10-01
```

应用前脚本先导出完整 D1 SQL 快照，并创建 SHA-256 校验的费用 JSON 备份；文件权限限制为当前用户。它按日期和不超过 100 条 SQL statement 的小批次更新费用字段，之后核对 token/source facts 未变化、重算覆盖率和差额。重跑相同价格版本会收敛为零变化。

如果需要回滚，且备份后 token/source facts 未变化：

```bash
corepack pnpm --filter @aiusage/worker run db:recalculate -- --remote --rollback /secure/path/aiusage-2026-10-01/aiusage-cost-backup.json --yes
```

回滚只恢复备份里的费用来源、金额、状态、价格版本和日 top-cost 字段。哈希错误或备份后有新用量/计数变化时会拒绝回滚；应先重新盘点当前范围，不能覆盖后续上传。完整 SQL 导出可用于数据库级恢复，JSON 文件用于这项工具的精确费用回滚。

## 无法从汇总恢复的字段

只有 D1 汇总行时，不可逆丢失的信息包括逐请求长上下文档、Fast/Priority 的具体请求、每次 cache write TTL、DeepSeek 峰谷时间、调用级重复记录、gateway 最终模型和供应商实扣金额。此类行只能标 `estimated` 或 `unavailable`；不要把 current catalog revaluation 写成发生日实际账单。补价后可通过 Overview 的未覆盖模型列表确认设备、日期和待处理 SKU。

Windows、macOS 与 Linux 的历史补齐都应以该设备的本地盘点和原始日志为依据。压缩归档必须经 scanner 成功解压并纳入完整日期扫描；CSV 汇总只能用于对照，不能替代逐请求重放，也不能据此上传只含单个工具的整日快照。

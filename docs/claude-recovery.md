# Claude Code 全量历史恢复审计

`@aiusage/worker` 的 `db:recover-claude` 是一次性、默认不写回用量数据的 D1 Time Travel 审计工具。它只在当前状态通过恢复校验后生成离线审计产物和候选 SQL，**永远不会自动执行任何 generated restore SQL，也不会自动执行 `daily_usage` 重算 SQL**。

恢复范围为：

```text
历史 PRE_RESET Claude dataset - 当前 Claude dataset = MISSING_CLAUDE_ROWS
```

Claude Code 主要按 `product` 识别，默认 alias 包含 `claude-code` 等历史拼写；provider 不限定为 `anthropic`。因此 `anthropic / claude-code` 和 `deepseek / claude-code` 都会进入审计，不能因为 `model` 名称包含 `claude` 就把 OpenCode、Copilot 等其他产品纳入范围。

## 运行前安全检查

1. 必须在维护窗口暂停 uploader，并在整个 Time Travel 操作期间保持暂停，避免恢复前后有新的写入。
2. 必须先记录操作前的 `CURRENT_BOOKMARK`。脚本会在 Phase A 保存 `CURRENT_BOOKMARK` 和 `current-bookmark.json`。
3. 确认 Wrangler 已认证，且只使用明确的 `--remote --uploader-paused --yes` 参数。
4. 不要让 PowerShell 的默认 code page 参与 SQL/JSON 产物的读取或写入。

```bash
pnpm --filter @aiusage/worker run db:recover-claude -- \
  --remote \
  --uploader-paused \
  --yes
```

默认历史点：

```text
Timestamp: 2026-08-12T16:54:43+08:00
Bookmark:  00000141-00000deb-000050c5-efa5f6bfdde085cd2dc817e624582eaf
```

如果历史快照使用了额外 product 名称，可显式追加（可重复）：

```bash
--claude-product legacy-claude-cli
```

## Time Travel bookmark 规则

执行：

```text
wrangler d1 time-travel restore aiusage-db --bookmark=<PRE_RESET>
```

Cloudflare restore 返回的字段语义是：

```json
{
  "bookmark": "PRE_RESET_BOOKMARK",
  "previous_bookmark": "CURRENT_STATE_BOOKMARK"
}
```

**`response.previous_bookmark` 才是 authoritative `UNDO_BOOKMARK`。**

- `response.bookmark` 是本次 restore 的目标历史 bookmark，只能表示 `PRE_RESET`，绝不能用作 undo。
- 脚本只从 `previous_bookmark` 提取 authoritative undo，不会从 `bookmark` fallback。
- `UNDO_BOOKMARK` 和 `undo-bookmark.json.bookmark` 记录实际用于恢复 current state 的 bookmark；JSON 同时记录 `source` 和 `authoritative`。
- 如果 `previous_bookmark` 缺失，脚本立即停止历史读取和 SQL 生成，并明确记录 fail-safe 路径；finally 仍会尽最大努力使用 Phase A 保存的 pre-operation current bookmark 恢复。日志会输出 `AUTHORITATIVE_UNDO_BOOKMARK=UNAVAILABLE` 和 emergency bookmark，不能把这条路径当作正常 authoritative undo。

脚本日志至少包含：

```text
AUTHORITATIVE_UNDO_BOOKMARK=...
RESTORE_CURRENT_ATTEMPTED=true
RESTORE_CURRENT_SUCCEEDED=true/false
```

## 恢复流程与 fail-safe

- **Phase A**：获取并写入操作前 `CURRENT_BOOKMARK`。
- **Phase B**：导出当前完整数据库，读取当前 breakdown/activity 和语义 baseline。
- **Phase C**：restore `PRE_RESET`；restore 成功返回后才将 `temporaryRestoreStarted` 置为 `true`，并立即保存 `previous_bookmark`。
- **Phase D/E**：在历史状态读取数据。如果读取或解析异常，仍进入 finally。
- **Phase F**：无论 Phase D/E 是否异常，都优先 restore `UNDO_BOOKMARK`，再做 current-state semantic validation。
- 如果 Phase F restore current 失败，脚本输出醒目的错误、authoritative undo bookmark（或 `UNAVAILABLE`）、人工命令，并停止；不会继续生成 recovery SQL。

如果脚本异常，先暂停 uploader，再读取产物中的 `UNDO_BOOKMARK`。当 `undo-bookmark.json.authoritative` 为 `true` 时，可手工执行：

```bash
wrangler d1 time-travel restore aiusage-db --bookmark=<UNDO_BOOKMARK>
```

如果 artifact 标记为 emergency fallback，或 `UNDO_BOOKMARK` 不存在，不要猜测 bookmark；使用日志中的 `EMERGENCY_CURRENT_BOOKMARK`，人工确认当前状态后再恢复。

## baseline validation

完整 SQL export 的 SHA-256 只作为辅助诊断，不能单独证明数据库语义恢复成功。`baseline-validation.json` 分成两层：

### Level 1：必须通过的语义校验

按稳定主键排序并规范化数据，对实际存在的表比较：

- `devices`
- `daily_usage`
- `daily_usage_breakdown`
- `daily_activity_breakdown`
- `d1_migrations`（若存在）以及相关 `sqlite_master` schema 状态

每个表输出 `rowCount`、`semanticHash`、`mismatchCount`；顶层输出 `semanticMatches`。只有 `semanticMatches: true` 才能进入离线差集分析。语义不一致时状态为 `CURRENT STATE NOT RESTORED` 并 STOP。

### Level 2：raw export SHA-256

`current-full-export.sql` 和 `restored-current-export.sql` 的 `expectedSha256` / `actualSha256` 及 `rawExportShaMatches` 仅用于辅助诊断。raw SHA 不一致但语义数据一致时，仍属于 `CURRENT STATE RESTORED`，不能仅凭 raw SHA 阻止分析。

## Windows / UTF-8 注意事项

恢复工具内部对 JSON、generated SQL 和文本产物明确使用 UTF-8；JSON 读取也明确按 UTF-8，raw SQL export 则按原始 UTF-8 字节计算辅助 SHA-256。中文不会依赖 Windows 当前 code page。

不要使用没有编码参数的 PowerShell `Get-Content`、`Set-Content`、重定向或 `Out-File` 改写产物。检查中文时使用明确的 UTF-8 工具，或直接让脚本读取产物。以下值必须原样 round-trip：

```text
AI生成代码-130df189
个人品牌网站-5941f682
E:\AI生成代码\aiusage
```

PowerShell `Group-Object` 默认可能按不区分大小写的语义分组，不能用它作为 recovery diff 去重工具。

## Key 与差集安全规则

Claude breakdown 唯一 key 严格对应 SQLite 主键，并使用 case-sensitive / ordinal 语义：

```text
device_id,
usage_date,
provider,
product,
channel,
model,
project
```

`E:\foo` 和 `e:\foo` 是两个不同 key。historical 去重、current lookup、`MISSING`、`CONFLICT`、`CURRENT_ONLY`、affected device/date 的计算都不能使用 locale-aware 或 case-insensitive dedupe。

- `MISSING` 才生成 `INSERT`。
- restore SQL 使用完整字段和 `ON CONFLICT (device_id, usage_date, provider, product, channel, model, project) DO NOTHING`。
- `CONFLICT` 只报告，不生成 `UPDATE` 或覆盖。
- `CURRENT_ONLY` 保留，不生成删除。
- activity 本轮只审计，不生成 activity INSERT。

`daily_usage` 重算产物只针对 affected `device_id` / `usage_date` 更新，并从完整 `daily_usage_breakdown` 重新计算 event/token 总量、四位小数 cost、`unavailable > estimated > exact` 的 `cost_status`、当前 `PRICING_VERSION`、`COALESCE(project_alias, project_display)` top project 和 top model。

## 产物

默认写入 `tmp/d1-claude-recovery-<timestamp>/`：

- `CURRENT_BOOKMARK` / `current-bookmark.json`
- `UNDO_BOOKMARK` / `undo-bookmark.json`
- `current-claude-all.json` / `historical-claude-all.json`
- `current-claude-activity-all.json` / `historical-claude-activity-all.json`
- `current-provider-product-distribution.json` / `historical-provider-product-distribution.json`
- `current-activity-provider-product-distribution.json` / `historical-activity-provider-product-distribution.json`
- `claude-diff.json`
- `historical-claude-coverage.json` / `current-claude-coverage.json`
- `restore-missing-claude.sql`
- `recalculate-affected-daily-usage.sql`
- `claude-recovery-report.md`
- `current-full-export.sql` / `restored-current-export.sql`
- `baseline-validation.json`

工具不会执行：

```text
restore-missing-claude.sql
recalculate-affected-daily-usage.sql
```

看到最终报告后，先人工检查 `CONFLICT`、`CURRENT_ONLY`、`missingDailyUsageParents`、日期级差异、语义 baseline 和成本统计；确认 uploader 仍暂停后，再由人工另行决定是否执行最终补数。

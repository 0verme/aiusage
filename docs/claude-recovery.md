# Claude Code 全量历史恢复审计

`@aiusage/worker` 的 `db:recover-claude` 是一次性、默认不写回用量数据的 D1 Time Travel 审计工具。恢复范围不是固定日期，而是：

```text
历史 PRE_RESET Claude dataset - 当前 Claude dataset = MISSING_CLAUDE_ROWS
```

其中 `product` 是 Claude Code 的筛选依据，不能因为 `model` 名称包含 `claude` 就把 OpenCode、Copilot 等其他产品纳入恢复范围。

## 运行

开始前必须暂停 uploader，并确认 Wrangler 已经具备 Cloudflare 认证：

```bash
pnpm --filter @aiusage/worker run db:recover-claude -- \
  --remote \
  --uploader-paused \
  --yes
```

默认使用以下历史点：

```text
Timestamp: 2026-08-12T16:54:43+08:00
Bookmark:  00000141-00000deb-000050c5-efa5f6bfdde085cd2dc817e624582eaf
```

如果历史快照使用了额外的 product 名称，可显式追加（可重复）：

```bash
--claude-product legacy-claude-cli
```

工具会先导出当前完整数据库，保存 `CURRENT_BOOKMARK`，读取当前全部 breakdown/activity；然后临时挂载 PRE_RESET，读取历史全部 breakdown/activity；最后立即用 `UNDO_BOOKMARK` restore 回当前状态，并比较前后完整导出 SHA-256。只有 `CURRENT STATE RESTORED` 校验通过后才会进行离线差集分析。

## 产物

默认写入 `tmp/d1-claude-recovery-<timestamp>/`：

- `current-claude-all.json` / `historical-claude-all.json`：完整原始 `daily_usage_breakdown` 行
- `current-claude-activity-all.json` / `historical-claude-activity-all.json`：完整原始 `daily_activity_breakdown` 行
- `current-provider-product-distribution.json` / `historical-provider-product-distribution.json`：全表 provider/product 分布，用于识别历史命名变化
- `claude-diff.json`：`MISSING`、`CONFLICT`、`CURRENT_ONLY`、每日状态、统计与 affected device/date
- `historical-claude-coverage.json` / `current-claude-coverage.json`：按日期的 Rows、Providers、Models、Projects、Events、Tokens、Estimated cost
- `restore-missing-claude.sql`：只包含历史存在而当前不存在的 `INSERT ... ON CONFLICT ... DO NOTHING`
- `recalculate-affected-daily-usage.sql`：仅针对 affected device/date 从 breakdown 重新 SUM 父表
- `claude-recovery-report.md`：日期覆盖、连续区间、token/cost、provider/model/project 汇总及 activity 差异
- `current-full-export.sql` / `restored-current-export.sql`：恢复安全校验用完整导出
- `CURRENT_BOOKMARK` / `UNDO_BOOKMARK`：Time Travel 安全回滚点

`CONFLICT` 行不会自动覆盖，`CURRENT_ONLY` 行不会删除或修改，activity 本轮只审计不生成 activity INSERT。

## STOP 规则

工具永远不会执行以下 SQL：

```text
restore-missing-claude.sql
recalculate-affected-daily-usage.sql
```

看到最终报告后，先人工检查 `CONFLICT`、`missingDailyUsageParents`、日期级差异和成本统计，再另行确认是否执行最终补数。

# Project Work Memory

Project Work Memory 是独立于 Usage Pipeline 的本地优先记忆链路。它复用 Codex、Claude Code、Pi 的本地 session 日志，归一化为 `Work Event`、`Project`、`Decision`、`Project State` 和 `Next Action`，不会把原始 conversation 写入 D1。

## 本地使用

默认模式是 `local-only`，数据保存在：

```text
~/.aiusage/memory.json
```

常用命令：

```bash
aiusage memory scan --yesterday
aiusage memory scan --range 7d
aiusage memory projects
aiusage memory show <project-name-or-id>
```

`memory scan` 只做本地 extraction 和幂等 upsert；重复扫描不会重复插入事件、决策或 Next Action。

## Cloud mode

只有显式开启后，`aiusage sync` 才会上传结构化 Memory：

```bash
aiusage config set memory.mode cloud
aiusage sync --yesterday
```

上传 payload 会移除本地路径、repository URL、source file provenance，以及敏感 metadata。`memory.mode` 仍建议保持 `local-only`，除非确实需要跨设备或 Dashboard 读取 Memory。

## Worker / Dashboard

先执行 D1 migration：

```bash
npx wrangler d1 execute aiusage-db --remote --file=packages/worker/migrations/0005_memory.sql
```

Memory ingest 使用独立 endpoint：

```text
POST /api/v1/memory/ingest
```

Dashboard 页面为 `/memory`。公开读取默认关闭；部署环境需要显式设置：

```text
MEMORY_PUBLIC=true
```

公开读取只返回结构化项目记忆，不返回本地路径或私有 repository URL。关闭公开读取时，Dashboard 会显示 local-only 提示，设备本地仍可使用 CLI 查看 Memory。

## 项目归一化

Project identity 优先使用 normalized Git remote，其次使用 Git common directory，再回退到 repository root / session cwd。因此同一 repository 的不同 worktree 会归一化为同一个 `projectId`；本地 alias 仍可通过既有 `projectAliases` 配置补充展示名称。

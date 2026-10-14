# 每日同步（Daily Sync）

本文说明如何把 **构建** 与 **每日采集** 拆成两个独立步骤。这不是风格偏好，而是
2026-10 连续 6 天数据缺口事故的直接修复项。

## 为什么必须拆开

事故链条：

1. 每日任务把「先重建、再采集」写在同一条命令里。
2. 重建每次都会失败：pnpm 在做包管理器自解析（`resolve package manager dependencies`）
   时写自身 lockfile 报 `ERR_PNPM_LOCKFILE_WRITE_FILE` / Windows `句柄无效。(os error 6)`。
3. 失败的重建**白白消耗执行器的时间预算**（该执行器对单条命令有 30s / 60s 硬上限）。
4. 紧接着的采集阶段被超时杀死，输出停在 `扫描 N 天 (...)`，既没有 `uploadedDays`，
   也没有退出码，看起来像「卡死」，实际是「被杀」。
5. 本地扫描数据在增长（Pi 会话 786 文件 / 1.03 GB），扫描本身也在变慢，
   两者相加越过了阈值，于是从 2026-10-09 起每天都失败。

结论：**采集路径里不允许出现 `pnpm install` / `pnpm build`。**
采集只应运行一个已经构建好、且能被证明来源的产物。

## 两个步骤

### 步骤 1：构建（人工 / CI，低频）

```bash
pnpm install --frozen-lockfile
pnpm --filter @0verme/aiusage-cli build
```

产物：

| 文件 | 用途 |
| --- | --- |
| `packages/cli/dist/cli.js` | 主 CLI |
| `packages/cli/dist/daily-sync.js` | 免构建的每日采集入口（只依赖 Node 内置模块） |
| `packages/cli/dist/build-info.json` | 构建来源（commit / commitDate / dirty / builtAt） |

也可以安装固定版本，让调度不必依赖仓库目录：

```bash
npm install -g @0verme/aiusage-cli@<version>
```

### 步骤 2：每日采集（调度器，高频）

```bash
node packages/cli/dist/daily-sync.js
```

默认等价于 `sync --yesterday`，即上传「前一天」的完整快照。常用变体：

```bash
node packages/cli/dist/daily-sync.js -- --today        # 上传当天
node packages/cli/dist/daily-sync.js -- --range 7d     # 补传最近 7 天
node packages/cli/dist/daily-sync.js --bundle /path/to/dist/cli.js
```

该入口的行为约定：

- **绝不**执行 install / build，仅依赖 Node 内置模块，不需要 `node_modules`，不需要 pnpm。
- 启动时打印 `build-info.json` 里的构建来源，日志里能直接看到「本次跑的是哪个提交」。
- 产物落后于源码时**只告警**，仍然照常采集。宁可这次用了偏旧的定价目录，
  也不要因为构建问题彻底停掉数据采集。
- 找不到产物时以退出码 `2` 失败，并提示去独立步骤构建，而不是自作主张去构建。
- 子进程被信号中断（例如调度器强杀）时以退出码 `3` 失败，且明确提示「上传结果未知，
  请核对服务端」，避免把「被中断」误读成「已完成」。

## 调度器配置

仓库内 `docs/aiusage-daily-sync-task.xml` 是 Windows 计划任务的参考定义，已修正为
`sync --yesterday`。

> 注意：计划任务里的参数若写成 `sync --today`，在 00:30 触发时只能扫到「今天刚开始」
> 的近乎空数据。必须用 `sync --yesterday`（或由 `daily-sync.js` 提供默认值）。

导入前请把 `<Command>` 指向前一步骤产出的、已固定版本的 CLI（下例为示意，请换成
本机实际路径）：

```xml
<Exec>
  <Command>node</Command>
  <Arguments>E:\AI生成代码\aiusage\packages\cli\dist\daily-sync.js</Arguments>
  <WorkingDirectory>E:\AI生成代码\aiusage</WorkingDirectory>
</Exec>
```

任务设置建议保留 `MultipleInstancesPolicy=IgnoreNew`，避免两次运行叠加。

## 如何确认调度跑的是哪份代码

`dist/` 不进版本管理，所以只靠版本号无法判断调度到底在跑哪次提交。
为此每次构建都会写入 `dist/build-info.json`，并由两处展示：

```bash
node packages/cli/dist/daily-sync.js        # 启动日志里的「构建来源」
aiusage doctor                              # 基本配置 分组里的「构建来源」
```

输出形如：

```
构建来源: 1.1.0 @ 062eaf7e37d1 built 2026-10-14T13:51:56.411Z
```

若构建时工作区有未提交改动，提交号后会带 `+dirty`；无法判断干净状态时标注
`(clean state unknown)`；两者都不代表产物不可用，只是提醒来源不是干净的提交。

排障顺序建议：

1. `aiusage doctor` 看「构建来源」是否为预期提交；若是 `unknown`，说明产物缺少
   `build-info.json`（例如直接跑源码，或产物来自旧版本），应重新构建或安装固定版本。
2. 看 `daily-sync.js` 是否打印「产物早于源码」告警；有告警说明该重建了，但不影响本次采集。
3. 只有确认产物来源正确后，再用 `scan` / `report` 核对数据口径。

## 三层可靠性约束

| 风险 | 保护机制 | 位置 |
| --- | --- | --- |
| 构建失败拖垮采集 | 构建与采集彻底分离，采集路径不含 pnpm | `dist/daily-sync.js` |
| 调度在跑旧代码而不自知 | `build-info.json` + doctor / 启动日志展示来源，过期只告警 | `build.mjs`、`version.ts`、`doctor.ts` |
| 空快照覆盖服务端历史 | token 明细为 0 的日期拒绝上传，并打印跳过原因 | `sync-plan.ts`、`cli.ts` |

关于第三条：服务端 `POST /api/v1/ingest/daily` 对每一天执行的是
`INSERT daily_usage ... ON CONFLICT DO UPDATE` 加上「先删 `daily_usage_breakdown`
再重插」，即整天替换。发送 0 条 breakdown 不会报错，只会把该日已有的 token 汇总清零、
明细删光。因此本地在构造上传计划时会跳过这种日期 —— 方向是明确的：
少传一天只会少一天数据，传空快照会破坏已有历史。

## 相关环境变量

| 变量 | 作用 |
| --- | --- |
| `AIUSAGE_CLI_BUNDLE` | 覆盖 `daily-sync.js` 要运行的 CLI 产物路径 |
| `AIUSAGE_REPO_ROOT` | 覆盖仓库根探测（用于判断产物是否落后于源码） |
| `AIUSAGE_MEMORY_TIMEOUT_MS` | Memory 阶段墙钟上限，默认 `60000`；`off` 表示不限时 |
| `AIUSAGE_MTIME_PREFILTER` | 设为 `off` 可关闭 mtime 预过滤、强制全量扫描 |

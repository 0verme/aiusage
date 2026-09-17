import { execFile } from 'node:child_process';

/**
 * 只读 SQLite 访问工具。
 *
 * Node 22.13+ 提供内置 `node:sqlite`；更老但仍受支持的 Node 版本回退到系统
 * `sqlite3` 可执行文件。两条路径都以只读方式打开数据库，scanner 永远不会修改
 * 用户的数据文件。
 *
 * 说明：`opencode.ts` 中还有一份等价实现（含运行时探测）。为避免在本改动中触碰
 * 其他 scanner，此处只抽取 Antigravity 需要的最小能力，未做统一重构。
 */

export type SqliteRow = Record<string, unknown>;

interface NodeSqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase;
}

/** 仅允许简单标识符，避免拼接出意外的 SQL。 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

let nodeSqliteModulePromise: Promise<NodeSqliteModule | null> | undefined;

/**
 * 读取整张表的原始行。查询失败（缺表、损坏、权限不足）时抛出异常，由调用方决定
 * 是跳过该数据源还是继续扫描其他数据源。
 */
export async function runSqliteQuery(dbPath: string, query: string): Promise<SqliteRow[]> {
  const nodeSqlite = await loadNodeSqlite();
  if (nodeSqlite) {
    const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(query).all().filter(isSqliteRow);
    } finally {
      db.close();
    }
  }

  const stdout = await runExternalSqlite(['-readonly', '-json', dbPath, query]);
  try {
    const parsed = JSON.parse(stdout || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSqliteRow) : [];
  } catch {
    throw new Error('sqlite3 returned unparseable JSON');
  }
}

/** 判断数据库是否存在指定表；数据库不可读时返回 false。 */
export async function sqliteHasTable(dbPath: string, table: string): Promise<boolean> {
  if (!SAFE_IDENTIFIER.test(table)) return false;
  try {
    const rows = await runSqliteQuery(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** 把 SQLite BLOB 列转成 Buffer；其他类型一律视为“没有数据”。 */
export function sqliteBlob(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    // 复用底层内存，避免为超大 BLOB 再复制一份。
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

async function loadNodeSqlite(): Promise<NodeSqliteModule | null> {
  nodeSqliteModulePromise ??= (async () => {
    try {
      // 保持 Node 18/20 兼容：该模块只在较新版本存在。
      const specifier = 'node:sqlite';
      // SAFETY: `node:sqlite` 是可选依赖；返回前用 DatabaseSync 的函数检查校验其形状。
      const module = await import(specifier) as unknown as Partial<NodeSqliteModule>;
      return typeof module.DatabaseSync === 'function' ? module as NodeSqliteModule : null;
    } catch {
      return null;
    }
  })();
  return nodeSqliteModulePromise;
}

function runExternalSqlite(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sqlite3',
      args,
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

function isSqliteRow(value: unknown): value is SqliteRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

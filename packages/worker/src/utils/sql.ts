/**
 * Dashboard 查询的内部上限，远低于 D1 的 statement size 限制，避免巨型 SQL
 * 在生产环境才失败。当前最大的 provider canonical 查询约 14 KB，50 KB 留有
 * provider 规则增长和少量筛选条件的余量。
 */
export const MAX_DASHBOARD_QUERY_BYTES = 50 * 1024;

export function sqlUtf8Bytes(sql: string): number {
	return new TextEncoder().encode(sql).length;
}

export function assertDashboardQuerySize(name: string, sql: string): string {
	const bytes = sqlUtf8Bytes(sql);
	if (bytes > MAX_DASHBOARD_QUERY_BYTES) {
		throw new Error(
			`Dashboard query '${name}' exceeds the ${MAX_DASHBOARD_QUERY_BYTES}-byte limit (${bytes} bytes)`,
		);
	}
	return sql;
}

export function prepareDashboardQuery<T>(
	database: { prepare(sql: string): T },
	name: string,
	sql: string,
): T {
	return database.prepare(assertDashboardQuerySize(name, sql));
}

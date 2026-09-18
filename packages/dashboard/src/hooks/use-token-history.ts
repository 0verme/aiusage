import { useEffect, useState } from 'react';
import type { TokenCompositionItem } from '@aiusage/shared';
import { DEMO_OVERVIEW } from '../demo-data';
import { buildQuery } from '../utils/data';
import type { FiltersState } from './use-overview';

export interface TokenHistoryPayload {
  /** 完整历史（range=all）的逐日 Token 序列，用于派生累计值。 */
  series: TokenCompositionItem[];
  loading: boolean;
  refresh: () => void;
}

/**
 * 取「完整历史」逐日 Token：复用现有 overview 接口，固定 range=all，不新增后端 API。
 *
 * query key 刻意排除 range —— 切换 7D/30D/90D/180D/本月 时不会重新请求，
 * 累计基线始终是完整历史，因此区间裁剪不会把累计值重新归零。
 * 请求失败时与 useOverview 一样回落到 demo 数据，保持本地开发可用。
 */
export function useTokenHistory(filters: FiltersState): TokenHistoryPayload {
  const query = buildQuery({ ...filters, range: 'all' });
  const [series, setSeries] = useState<TokenCompositionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/public/overview?${query}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) throw new Error('Response is not JSON');
        const payload = (await response.json()) as { tokenComposition?: TokenCompositionItem[] };
        if (cancelled) return;
        setSeries(payload.tokenComposition ?? []);
      } catch {
        if (cancelled) return;
        setSeries(DEMO_OVERVIEW.tokenComposition);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [query, tick]);

  return { series, loading, refresh: () => setTick((n) => n + 1) };
}

import {
  canonicalizeModel,
  canonicalizeProvider,
  displayModelName,
  type FacetOption,
  type ModelShareItem,
  type SankeyGraph,
  type SankeyNode,
} from '@aiusage/shared';
import type { OverviewPayload, FiltersState } from '../hooks/use-overview';
import { arrSum } from './format';
import { scaleModelShares } from './share-data';

const SANKEY_SOURCE_COLORS = [
  '#22d3ee',
  '#fb923c',
  '#60a5fa',
  '#a78bfa',
  '#34d399',
  '#f472b6',
  '#fbbf24',
  '#f87171',
] as const;

export interface DashboardSankeyNode {
  name: string;
  color: string;
  totalTokens: number;
  rawModels?: string[];
  aliasCount?: number;
}

export interface DashboardSankeyLink {
  source: number;
  target: number;
  value: number;
  color: string;
}

export interface DashboardSankeyData {
  nodes: DashboardSankeyNode[];
  links: DashboardSankeyLink[];
}

/** 兼容旧 API/demo：在前端再次按 shared canonical model 合并模型维度。 */
export function normalizeModelDimensions(
  overview: OverviewPayload,
  mergeAliases = true,
): OverviewPayload {
  if (!mergeAliases) return overview;
  return {
    ...overview,
    modelCostShare: mergeModelShareItems(overview.modelCostShare),
    sankey: mergeSankeyModelNodes(overview.sankey),
    filters: {
      ...overview.filters,
      selection: {
        ...overview.filters.selection,
        model: [...new Set(overview.filters.selection.model.map((value) => canonicalizeModel(value)))],
      },
      options: {
        ...overview.filters.options,
        models: mergeModelFacetOptions(overview.filters.options.models),
      },
    },
  };
}

export function mergeModelShareItems(items: ModelShareItem[]): ModelShareItem[] {
  const merged = new Map<string, ModelShareItem & { rawModelSet: Set<string> }>();
  for (const item of items) {
    const value = canonicalizeModel(item.value);
    const existing = merged.get(value);
    const rawModels = rawModelsFor(item.value, item.rawModels);
    if (existing) {
      existing.estimatedCostUsd += Number(item.estimatedCostUsd || 0);
      existing.eventCount += Number(item.eventCount || 0);
      existing.totalTokens += Number(item.totalTokens || 0);
      for (const rawModel of rawModels) existing.rawModelSet.add(rawModel);
      continue;
    }
    merged.set(value, {
      ...item,
      value,
      label: displayModelName(value),
      estimatedCostUsd: Number(item.estimatedCostUsd || 0),
      eventCount: Number(item.eventCount || 0),
      totalTokens: Number(item.totalTokens || 0),
      rawModels: undefined,
      aliasCount: undefined,
      rawModelSet: new Set(rawModels),
    });
  }
  return [...merged.values()].map(({ rawModelSet, ...item }) => withModelMetadata(item, rawModelSet));
}

export function mergeModelFacetOptions(items: FacetOption[]): FacetOption[] {
  const merged = new Map<string, FacetOption & { rawModelSet: Set<string> }>();
  for (const item of items) {
    const value = canonicalizeModel(item.value);
    const rawModels = rawModelsFor(item.value, item.rawModels);
    const existing = merged.get(value);
    if (existing) {
      existing.estimatedCostUsd += Number(item.estimatedCostUsd || 0);
      existing.eventCount += Number(item.eventCount || 0);
      for (const rawModel of rawModels) existing.rawModelSet.add(rawModel);
      continue;
    }
    merged.set(value, {
      ...item,
      value,
      label: displayModelName(value),
      estimatedCostUsd: Number(item.estimatedCostUsd || 0),
      eventCount: Number(item.eventCount || 0),
      rawModels: undefined,
      aliasCount: undefined,
      rawModelSet: new Set(rawModels),
    });
  }
  return [...merged.values()]
    .map(({ rawModelSet, ...item }) => withModelMetadata(item, rawModelSet))
    .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd || left.label.localeCompare(right.label));
}

function mergeSankeyModelNodes(input: SankeyGraph): SankeyGraph {
  const nodeIdMap = new Map<string, string>();
  const mergedNodes = new Map<string, SankeyNode & { rawModelSet: Set<string> }>();

  for (const node of input.nodes) {
    if (node.layer !== 0) {
      nodeIdMap.set(node.id, node.id);
      if (!mergedNodes.has(node.id)) mergedNodes.set(node.id, { ...node, rawModelSet: new Set() });
      continue;
    }

    const rawModel = node.id.startsWith('model-') ? node.id.slice('model-'.length) : node.label;
    const canonical = canonicalizeModel(rawModel);
    const id = `model-${canonical}`;
    nodeIdMap.set(node.id, id);
    const rawModels = rawModelsFor(rawModel, node.rawModels);
    const existing = mergedNodes.get(id);
    if (existing) {
      existing.totalTokens += Number(node.totalTokens || 0);
      for (const value of rawModels) existing.rawModelSet.add(value);
    } else {
      mergedNodes.set(id, {
        ...node,
        id,
        label: displayModelName(canonical),
        totalTokens: Number(node.totalTokens || 0),
        rawModels: undefined,
        aliasCount: undefined,
        rawModelSet: new Set(rawModels),
      });
    }
  }

  const mergedLinks = new Map<string, { source: string; target: string; value: number }>();
  for (const link of input.links) {
    const source = nodeIdMap.get(link.source) ?? link.source;
    const target = nodeIdMap.get(link.target) ?? link.target;
    const key = `${source}\0${target}`;
    const existing = mergedLinks.get(key);
    if (existing) existing.value += Number(link.value || 0);
    else mergedLinks.set(key, { source, target, value: Number(link.value || 0) });
  }

  return {
    nodes: [...mergedNodes.values()].map(({ rawModelSet, ...node }) => withModelMetadata(node, rawModelSet)),
    links: [...mergedLinks.values()],
  };
}

function rawModelsFor(value: string, rawModels?: string[]): string[] {
  const values = rawModels?.filter(Boolean) ?? [];
  if (!values.includes(value)) values.push(value);
  return [...new Set(values)];
}

function withModelMetadata<T extends { rawModels?: string[]; aliasCount?: number }>(
  item: T,
  rawModelSet: Set<string>,
): T {
  const rawModels = [...rawModelSet].filter(Boolean).sort((left, right) => left.localeCompare(right));
  return {
    ...item,
    ...(rawModels.length > 0 ? { rawModels } : {}),
    ...(rawModels.length > 1 ? { aliasCount: rawModels.length } : {}),
  };
}

/** Get all YYYY-MM-DD dates for the current month (1st to last day). */
export function currentMonthDates(): string[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const result: string[] = [];
  for (let d = 1; d <= last; d++) {
    result.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return result;
}

/** Filter overview data to current month and pad remaining days with zeros. */
export function padMonth(ov: OverviewPayload): OverviewPayload {
  const allDates = currentMonthDates();

  const trendMap = new Map(ov.dailyTrend.map((d) => [d.usageDate, d]));
  const compMap = new Map(ov.tokenComposition.map((d) => [d.usageDate, d]));

  const dailyTrend = allDates.map((date) => trendMap.get(date) ?? { usageDate: date, eventCount: 0, estimatedCostUsd: 0 });
  const tokenComposition = allDates.map((date) => compMap.get(date) ?? {
    usageDate: date, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  });

  const monthTrend = dailyTrend.filter((d) => d.estimatedCostUsd > 0);
  const totalCostUsd = arrSum(monthTrend.map((d) => d.estimatedCostUsd));
  const totalEvents = arrSum(monthTrend.map((d) => d.eventCount));
  const activeDays = monthTrend.length;

  // Scale share/sankey data to the frontend-only current-month window.
  const ratio = ov.totalCostUsd > 0 ? totalCostUsd / ov.totalCostUsd : 0;
  const fullRangeTokens = arrSum(ov.tokenComposition.map((d) => d.totalTokens));
  const monthTokens = arrSum(tokenComposition.map((d) => d.totalTokens));
  const tokenRatio = fullRangeTokens > 0 ? monthTokens / fullRangeTokens : 0;
  const eventRatio = ov.totalEvents > 0 ? totalEvents / ov.totalEvents : 0;

  function scaleShares<T extends { estimatedCostUsd: number; eventCount: number }>(items: T[]): T[] {
    return items.map((it) => ({
      ...it,
      estimatedCostUsd: +(it.estimatedCostUsd * ratio).toFixed(4),
      eventCount: Math.round(it.eventCount * eventRatio),
    }));
  }

  const sankey = ov.sankey.nodes.length ? {
    nodes: ov.sankey.nodes.map((n) => ({ ...n, totalTokens: Math.round(n.totalTokens * ratio) })),
    links: ov.sankey.links.map((l) => ({ ...l, value: Math.round(l.value * ratio) })),
  } : ov.sankey;

  // Filter provider daily trend to current month
  const monthDateSet = new Set(allDates);
  const providerDailyTrend = (ov.providerDailyTrend ?? []).filter(
    (item) => monthDateSet.has(item.usageDate),
  );

  return {
    ...ov,
    totalDays: allDates.length,
    activeDays,
    totalEvents,
    totalCostUsd,
    averageDailyCostUsd: activeDays > 0 ? totalCostUsd / activeDays : 0,
    dailyTrend,
    providerDailyTrend,
    tokenComposition,
    modelCostShare: scaleModelShares(ov.modelCostShare, ratio, tokenRatio),
    channelCostShare: scaleShares(ov.channelCostShare),
    sankey,
    filters: {
      ...ov.filters,
      options: {
        ...ov.filters.options,
        providers: scaleShares(ov.filters.options.providers),
      },
    },
  };
}

export function buildQuery(f: FiltersState): string {
  const p = new URLSearchParams();
  const aliases: Record<string, string> = {
    deviceIds: 'deviceId',
    products: 'product',
    models: 'model',
    projects: 'project',
  };
  for (const [k, v] of Object.entries(f)) {
    if (k === 'mergeModelAliases') {
      if (v === false) p.set(k, '0');
      continue;
    }
    if (Array.isArray(v)) {
      const key = aliases[k] ?? k;
      v.filter(Boolean).forEach((item) => p.append(key, item));
      continue;
    }
    if (!v) continue;
    p.set(k, v);
  }
  return p.toString();
}

export function transformSankey(input?: SankeyGraph): DashboardSankeyData | null {
  if (!input?.nodes.length || !input?.links.length) return null;

  // Fold small target nodes into "Other" if too many
  const MAX_TARGETS = 8;
  const targetIds = new Set(input.links.map((l) => l.target));
  const sourceIds = new Set(input.links.map((l) => l.source));
  const pureTargets = [...targetIds].filter((id) => !sourceIds.has(id));

  let nodes = input.nodes;
  let links = input.links;

  if (pureTargets.length > MAX_TARGETS) {
    const targetVolume = new Map<string, number>();
    for (const l of links) {
      if (pureTargets.includes(l.target)) {
        targetVolume.set(l.target, (targetVolume.get(l.target) || 0) + Number(l.value || 0));
      }
    }
    const sorted = [...targetVolume.entries()].sort((a, b) => b[1] - a[1]);
    const keepSet = new Set(sorted.slice(0, MAX_TARGETS - 1).map(([id]) => id));
    const otherId = '__other__';

    nodes = [
      ...input.nodes.filter((n) => !pureTargets.includes(n.id) || keepSet.has(n.id)),
      { id: otherId, label: 'Other', layer: Math.max(...input.nodes.map((n) => n.layer)), totalTokens: 0 },
    ];
    links = input.links.map((l) =>
      pureTargets.includes(l.target) && !keepSet.has(l.target)
        ? { ...l, target: otherId }
        : l,
    );
  }

  const sourceColorMap = new Map<string, string>();
  nodes
    .filter((node) => node.layer === 0)
    .forEach((node, index) => {
      sourceColorMap.set(node.id, SANKEY_SOURCE_COLORS[index % SANKEY_SOURCE_COLORS.length]);
    });

  const nodeList = nodes.map((n) => ({
    name: n.label || n.id,
    color: sourceColorMap.get(n.id) ?? 'var(--flow-target-edge)',
    totalTokens: Number(n.totalTokens || 0),
    ...(n.layer === 0 && n.rawModels ? { rawModels: n.rawModels, aliasCount: n.aliasCount } : {}),
  }));
  const idToIdx = new Map(nodes.map((n, i) => [n.id, i]));

  // Merge duplicate links (same source→target after folding)
  const merged = new Map<string, DashboardSankeyLink>();
  for (const l of links) {
    const si = idToIdx.get(l.source);
    const ti = idToIdx.get(l.target);
    if (si === undefined || ti === undefined || Number(l.value || 0) <= 0) continue;
    const key = `${si}-${ti}`;
    const prev = merged.get(key);
    if (prev) prev.value += Number(l.value);
    else {
      merged.set(key, {
        source: si,
        target: ti,
        value: Number(l.value),
        color: sourceColorMap.get(l.source) ?? 'rgba(34, 211, 238, 0.35)',
      });
    }
  }

  const finalLinks = [...merged.values()];
  return finalLinks.length ? { nodes: nodeList, links: finalLinks } : null;
}

export function pivotProviderTrend(
  dailyTrend: OverviewPayload['dailyTrend'],
  providerTrend: OverviewPayload['providerDailyTrend'],
): { data: Record<string, unknown>[]; providers: string[] } {
  const providerSet = new Set<string>();
  const dateMap = new Map<string, Record<string, number>>();

  for (const r of providerTrend ?? []) {
    const provider = canonicalizeProvider({ provider: r.provider });
    providerSet.add(provider);
    const existing = dateMap.get(r.usageDate) ?? {};
    existing[provider] = (existing[provider] ?? 0) + r.estimatedCostUsd;
    dateMap.set(r.usageDate, existing);
  }

  const providers = [...providerSet];
  const data = dailyTrend.map((d) => ({
    usageDate: d.usageDate,
    ...Object.fromEntries(providers.map((p) => [p, dateMap.get(d.usageDate)?.[p] ?? 0])),
  }));

  return { data, providers };
}

import { scanAntigravityDates } from './scanners/antigravity.js';
import { scanClaudeDates } from './scanners/claude.js';
import { scanCodexDates } from './scanners/codex.js';
import { scanCopilotDates } from './scanners/copilot.js';
import { scanCopilotVscodeDates } from './scanners/copilot-vscode.js';
import { scanCursorDates } from './scanners/cursor.js';
import { scanGeminiDates } from './scanners/gemini.js';
import { scanQwenDates } from './scanners/qwen.js';
import { scanKimiDates } from './scanners/kimi.js';
import { scanAmpDates } from './scanners/amp.js';
import { scanDroidDates } from './scanners/droid.js';
import { scanOpencodeDates } from './scanners/opencode.js';
import { scanPiDates } from './scanners/pi.js';
import { scanGrokBuildDates } from './scanners/grok-build.js';
import { scanTraeDates } from './scanners/trae.js';

import type { IngestBreakdown, PricingCatalog } from '@aiusage/shared';

export interface ScanResult {
  usageDate: string;
  breakdowns: IngestBreakdown[];
  totals: {
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
}

export interface ScanOptions {
  projectAliases?: Record<string, string>;
  opencodeDbPaths?: readonly string[];
  /** Pricing catalog used by scanners that can emit event-level exact costs. */
  pricingCatalog?: PricingCatalog;
  /** Product ids selected by the user-facing --tool filter. */
  tools?: readonly string[];
  /** Emit per-scanner progress for long-running sync operations. */
  progress?: boolean;
}

export const TOOL_IDS = [
  'amp',
  'antigravity',
  'claude-code',
  'codex',
  'copilot-cli',
  'copilot-vscode',
  'cursor',
  'droid',
  'gemini-cli',
  'grok-build',
  'kimi-code',
  'opencode',
  'pi',
  'qwen-code',
  'trae',
  'trae-cn',
  'trae-intl',
] as const;

const TOOL_ID_SET = new Set<string>(TOOL_IDS);

/**
 * Parse a comma-separated --tool value. `trae` is a stable alias for both
 * editions and the short-lived legacy `product=trae` rows from CLI 1.7.5.
 */
export function parseToolSelection(value: string | boolean | undefined, zh = false): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(zh ? '--tool 需要指定工具名称' : '--tool requires a tool name');
  }

  const selected = new Set<string>();
  for (const raw of value.split(',')) {
    const tool = raw.trim().toLowerCase();
    if (!TOOL_ID_SET.has(tool)) {
      throw new Error(zh
        ? `未知工具: ${raw.trim()}。可用值: ${TOOL_IDS.join(', ')}`
        : `Unknown tool: ${raw.trim()}. Available values: ${TOOL_IDS.join(', ')}`);
    }
    if (tool === 'trae') {
      selected.add('trae-cn');
      selected.add('trae-intl');
      selected.add('trae');
    } else {
      selected.add(tool);
    }
  }
  return [...selected];
}

export async function scanDate(targetDate: string, options: ScanOptions = {}): Promise<ScanResult> {
  const [result] = await scanDates([targetDate], options);
  return result ?? {
    usageDate: targetDate,
    breakdowns: [],
    totals: createEmptyTotals(),
  };
}

export async function scanDates(targetDates: string[], options: ScanOptions = {}): Promise<ScanResult[]> {
  const uniqueDates = [...new Set(targetDates)];
  if (uniqueDates.length === 0) return [];

  const selected = options.tools ? new Set(options.tools) : undefined;
  const scannerDefinitions: Array<{ name: string; products: string[]; scan: () => Promise<Map<string, IngestBreakdown[]>> }> = [
    { name: 'antigravity', products: ['antigravity'], scan: () => scanAntigravityDates(uniqueDates) },
    { name: 'claude-code', products: ['claude-code'], scan: () => scanClaudeDates(uniqueDates, undefined, options.projectAliases) },
    {
      name: 'codex',
      products: ['codex'],
      scan: () => scanCodexDates(uniqueDates, undefined, options.projectAliases, options.pricingCatalog),
    },
    { name: 'copilot-cli', products: ['copilot-cli'], scan: () => scanCopilotDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'copilot-vscode', products: ['copilot-vscode'], scan: () => scanCopilotVscodeDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'cursor', products: ['cursor'], scan: () => scanCursorDates(uniqueDates) },
    { name: 'gemini-cli', products: ['gemini-cli'], scan: () => scanGeminiDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'qwen-code', products: ['qwen-code'], scan: () => scanQwenDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'kimi-code', products: ['kimi-code'], scan: () => scanKimiDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'amp', products: ['amp'], scan: () => scanAmpDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'droid', products: ['droid'], scan: () => scanDroidDates(uniqueDates, undefined, options.projectAliases) },
    {
      name: 'opencode',
      products: ['opencode'],
      scan: () => scanOpencodeDates(uniqueDates, {
        projectAliases: options.projectAliases,
        dbPaths: options.opencodeDbPaths,
      }),
    },
    { name: 'pi', products: ['pi'], scan: () => scanPiDates(uniqueDates, undefined, options.projectAliases) },
    { name: 'grok-build', products: ['grok-build'], scan: () => scanGrokBuildDates(uniqueDates, undefined, options.projectAliases) },
    {
      name: 'trae',
      products: ['trae-cn', 'trae-intl', 'trae'],
      scan: () => scanTraeDates(uniqueDates, { projectAliases: options.projectAliases }),
    },
  ];

  const scanners = scannerDefinitions
    .filter(definition => !selected || definition.products.some(product => selected.has(product)))
    .map(async ({ name, scan }) => {
      const startedAt = Date.now();
      if (options.progress) console.log(`[scan] ${name} started`);
      try {
        const result = await scan();
        if (options.progress) {
          const breakdownCount = [...result.values()].reduce((count, breakdowns) => count + breakdowns.length, 0);
          console.log(`[scan] ${name} completed in ${Date.now() - startedAt} ms (${breakdownCount} breakdowns)`);
        }
        return result;
      } catch (error) {
        if (options.progress) console.error(`[scan] ${name} failed after ${Date.now() - startedAt} ms`);
        throw error;
      }
    });

  const results = await Promise.all(scanners);

  return uniqueDates.map((usageDate) => {
    const breakdowns = results
      .flatMap(m => m.get(usageDate) ?? [])
      .filter(breakdown => !selected || selected.has(breakdown.product));
    const totals = breakdowns.reduce(
      (acc, b) => ({
        eventCount: acc.eventCount + b.eventCount,
        inputTokens: acc.inputTokens + b.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + b.cachedInputTokens,
        cacheWriteTokens: acc.cacheWriteTokens + b.cacheWriteTokens,
        outputTokens: acc.outputTokens + b.outputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + b.reasoningOutputTokens,
      }),
      createEmptyTotals(),
    );

    return { usageDate, breakdowns, totals };
  });
}

function createEmptyTotals(): ScanResult['totals'] {
  return {
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

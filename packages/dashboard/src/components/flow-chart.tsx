import { Sankey, ResponsiveContainer, Tooltip } from 'recharts';
import type { SankeyGraph } from '@aiusage/shared';
import { formatCompact } from '../utils/format';
import type { DashboardSankeyLink, DashboardSankeyNode } from '../utils/data';
import { transformSankey } from '../utils/data';
import { EmptyState } from './chart-helpers';

function SankeyNode({
  x, y, width, height, payload,
}: {
  x: number; y: number; width: number; height: number;
  payload: DashboardSankeyNode;
}) {
  const isLeft = x < 200;
  const targetRailWidth = Math.max(96, width + 88);
  const targetRailX = x - targetRailWidth + width;
  const labelY = y + height / 2 - (payload.totalTokens > 0 ? 7 : 0);
  const valueY = labelY + 17;

  return (
    <g>
      {isLeft ? (
        <rect x={x} y={y} width={Math.max(10, width)} height={height} rx={3} fill={payload.color} />
      ) : (
        <>
          <rect
            x={targetRailX}
            y={y}
            width={targetRailWidth}
            height={height}
            rx={4}
            fill="var(--flow-target)"
            stroke="var(--border)"
            strokeWidth={1}
          />
          <rect x={x - 6} y={y} width={6} height={height} rx={3} fill="var(--flow-target-edge)" />
        </>
      )}
      <text
        x={isLeft ? x + Math.max(10, width) + 10 : x - 14}
        y={labelY}
        textAnchor={isLeft ? 'start' : 'end'}
        dominantBaseline="central"
        className="flow-node-label"
      >
        {payload.name}
      </text>
      {payload.totalTokens > 0 && (
        <text
          x={isLeft ? x + Math.max(10, width) + 10 : x - 14}
          y={valueY}
          textAnchor={isLeft ? 'start' : 'end'}
          dominantBaseline="central"
          className="flow-node-value"
        >
          {formatCompact(payload.totalTokens)}
        </text>
      )}
    </g>
  );
}

function SankeyLink({
  sourceX,
  sourceY,
  sourceControlX,
  targetX,
  targetY,
  targetControlX,
  linkWidth,
  payload,
}: {
  sourceX: number;
  sourceY: number;
  sourceControlX: number;
  targetX: number;
  targetY: number;
  targetControlX: number;
  linkWidth: number;
  payload: DashboardSankeyLink;
}) {
  return (
    <path
      d={`
        M${sourceX},${sourceY}
        C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}
      `}
      fill="none"
      stroke={payload.color}
      strokeOpacity={0.2}
      strokeLinecap="round"
      strokeWidth={linkWidth}
    />
  );
}

export function FlowChart({ data }: { data?: SankeyGraph }) {
  const sankeyData = transformSankey(data);
  if (!sankeyData) return <EmptyState label="No flow data" />;

  const sourceCount = sankeyData.nodes.filter((_, index) => sankeyData.links.some((link) => link.source === index)).length;
  const targetCount = sankeyData.nodes.length - sourceCount;
  const height = Math.max(420, Math.max(sourceCount, targetCount) * 48 + 40);

  return (
    <div style={{ height }} className="flow-chart w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={sankeyData}
          nodePadding={28}
          nodeWidth={8}
          margin={{ left: 0, right: 0, top: 4, bottom: 4 }}
          link={(props: DashboardSankeyLink & {
            sourceX: number;
            sourceY: number;
            sourceControlX: number;
            targetX: number;
            targetY: number;
            targetControlX: number;
            linkWidth: number;
            payload: DashboardSankeyLink;
          }) => <SankeyLink {...props} />}
          node={(props: {
            x: number;
            y: number;
            width: number;
            height: number;
            payload: DashboardSankeyNode;
          }) => <SankeyNode {...props} />}
        >
          <Tooltip
            cursor={false}
            content={// eslint-disable-next-line @typescript-eslint/no-explicit-any
            (props: any) => {
              const pl = props.payload as Array<Record<string, unknown>> | undefined;
              if (!pl?.length) return null;
              const d = (pl[0]?.payload ?? pl[0]) as Record<string, unknown>;
              if (!d) return null;
              // Link hover: source/target are node objects with .name
              const srcNode = d.source as { name?: string } | undefined;
              const tgtNode = d.target as { name?: string } | undefined;
              // Node hover: just has .name
              const nodeName = (d as { name?: string }).name;
              const rawModels = (d as { rawModels?: string[] }).rawModels;
              const val = Number(d.value ?? 0);
              if (srcNode?.name && tgtNode?.name) {
                return (
                  <div className="flow-tooltip rounded-lg border px-3 py-2 font-mono text-[12px]" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
                    <div className="font-semibold" style={{ color: 'var(--fg)' }}>{srcNode.name} → {tgtNode.name}</div>
                    <div className="mt-0.5 tabular-nums" style={{ color: 'var(--fg2)' }}>{formatCompact(val)} tokens</div>
                  </div>
                );
              }
              if (nodeName) {
                return (
                  <div className="flow-tooltip rounded-lg border px-3 py-2 font-mono text-[12px]" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
                    <div className="font-semibold" style={{ color: 'var(--fg)' }}>{nodeName}</div>
                    {val > 0 && <div className="mt-0.5 tabular-nums" style={{ color: 'var(--fg2)' }}>{formatCompact(val)} tokens</div>}
                    {rawModels && rawModels.length > 1 && (
                      <div className="mt-1.5 text-[11px]" style={{ color: 'var(--fg3)' }}>
                        <div>Raw model aliases:</div>
                        {rawModels.map((rawModel) => <div key={rawModel}>- {rawModel}</div>)}
                      </div>
                    )}
                  </div>
                );
              }
              return null;
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}

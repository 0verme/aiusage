import { Search, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { MemoryOverviewResponse, MemoryProjectView } from "@aiusage/shared";
import { useLayout } from "../components/layout";

interface MemoryApiResponse extends MemoryOverviewResponse {
  ok: boolean;
}

export function MemoryPage() {
  const { locale, t } = useLayout();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [data, setData] = useState<MemoryApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (submittedQuery.trim()) params.set("q", submittedQuery.trim());
        const response = await fetch(`/api/v1/public/memory?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as MemoryApiResponse;
        setData(payload);
      } catch {
        if (!controller.signal.aborted) {
          setData(null);
          setError(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [submittedQuery]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query);
  };

  return (
    <section className="mx-auto grid w-full max-w-[1200px] gap-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--fg3)]">
            {t.memory}
          </div>
          <h2 className="mt-1 text-[22px] font-semibold tracking-tight text-[var(--fg)]">
            {locale === "zh" ? "项目工作记忆" : "Project Work Memory"}
          </h2>
        </div>
        {data && (
          <div className="font-mono text-[11px] text-[var(--fg3)]">
            {data.totalProjects} {locale === "zh" ? "个项目" : "projects"} · {data.totalEvents} {locale === "zh" ? "条事件" : "events"}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fg3)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.memorySearch}
          className="h-10 w-full rounded-[10px] border bg-[var(--panel)] pl-9 pr-24 text-[13px] text-[var(--fg)] outline-none transition focus:border-[var(--accent)]"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          type="submit"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[7px] bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white transition hover:opacity-90"
        >
          {locale === "zh" ? "搜索" : "Search"}
        </button>
      </form>

      {loading && !data ? (
        <div className="card flex min-h-[220px] items-center justify-center text-[13px] text-[var(--fg3)]">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          {locale === "zh" ? "加载 Memory…" : "Loading memory…"}
        </div>
      ) : error ? (
        <div className="card grid gap-2 p-6 text-[13px]">
          <div className="font-medium text-[var(--fg)]">{t.memoryUnavailable}</div>
          <div className="text-[var(--fg2)]">{t.memoryLocalOnlyNotice}</div>
        </div>
      ) : data?.projects.length ? (
        <div className="grid gap-4">
          {data.projects.map((view) => (
            <MemoryProjectCard key={view.project.projectId} view={view} locale={locale} t={t} />
          ))}
        </div>
      ) : (
        <div className="card p-6 text-[13px] text-[var(--fg2)]">
          {t.memoryEmpty}
        </div>
      )}
    </section>
  );
}

function MemoryProjectCard({
  view,
  locale,
  t,
}: {
  view: MemoryProjectView;
  locale: "en" | "zh";
  t: Record<string, string>;
}) {
  const state = view.state;
  return (
    <article className="card grid gap-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4" style={{ borderColor: "var(--border)" }}>
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-semibold text-[var(--fg)]">{view.project.projectName}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg3)]">
            <span>{locale === "zh" ? "更新" : "Updated"} {formatDate(view.project.lastSeenAt)}</span>
            <span>·</span>
            <span className="font-mono">{view.project.projectId}</span>
          </div>
        </div>
        <span className="rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--fg2)]" style={{ borderColor: "var(--border)" }}>
          {view.project.status}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.05fr_1fr_1fr]">
        <MemoryState state={state} locale={locale} t={t} />
        <MemoryDecisions view={view} locale={locale} t={t} />
        <MemoryNext view={view} locale={locale} t={t} />
      </div>

      <div className="border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg3)]">
          {t.memoryRecentActivity}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {view.recentEvents.slice(0, 6).map((event) => (
            <div key={event.id} className="min-w-0 rounded-lg bg-[var(--panel-soft)] px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--fg3)]">
                <span className="uppercase tracking-[0.06em]">{event.eventType}</span>
                <span>{formatDate(event.occurredAt)}</span>
              </div>
              <div className="mt-1 truncate text-[12px] font-medium text-[var(--fg2)]">{event.title}</div>
              <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--fg3)]">
                <span>{event.source}</span>
                <span>·</span>
                <span className="truncate">{event.sourceRef.sourceSessionId}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </div>
            </div>
          ))}
          {view.recentEvents.length === 0 && <div className="text-[12px] text-[var(--fg3)]">{t.memoryEmpty}</div>}
        </div>
      </div>
    </article>
  );
}

function MemoryState({ state, locale, t }: { state: MemoryProjectView["state"]; locale: "en" | "zh"; t: Record<string, string> }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg3)]">{t.memoryCurrentState}</div>
      <div className="text-[13px] leading-6 text-[var(--fg2)]">{state?.summary || t.memoryEmpty}</div>
      {state && <div className="mt-2 text-[11px] text-[var(--accent)]">{locale === "zh" ? "阶段" : "Phase"}: {state.currentPhase}</div>}
      {state?.blockers.length ? <div className="mt-2 text-[11px] text-[var(--orange)]">{locale === "zh" ? "阻塞" : "Blockers"}: {state.blockers.join(" · ")}</div> : null}
    </div>
  );
}

function MemoryDecisions({ view, locale, t }: { view: MemoryProjectView; locale: "en" | "zh"; t: Record<string, string> }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg3)]">{t.memoryRecentDecisions}</div>
      <div className="grid gap-2">
        {view.recentDecisions.slice(0, 4).map((decision) => (
          <div key={decision.id} className="text-[12px] leading-5 text-[var(--fg2)]">
            <span className="mr-1 text-[var(--accent)]">·</span>
            <span className="font-medium">{decision.decision}</span>
            <span className="ml-1 text-[10px] text-[var(--fg3)]">({decision.status})</span>
          </div>
        ))}
        {view.recentDecisions.length === 0 && <div className="text-[12px] text-[var(--fg3)]">{t.memoryEmpty}</div>}
      </div>
    </div>
  );
}

function MemoryNext({ view, locale, t }: { view: MemoryProjectView; locale: "en" | "zh"; t: Record<string, string> }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg3)]">{t.memoryNextActions}</div>
      <div className="grid gap-2">
        {view.nextActions.slice(0, 5).map((action) => (
          <div key={action.id} className="flex gap-2 text-[12px] leading-5 text-[var(--fg2)]">
            <span className="text-[var(--green)]">·</span>
            <span>{action.content}</span>
          </div>
        ))}
        {view.nextActions.length === 0 && <div className="text-[12px] text-[var(--fg3)]">{t.memoryEmpty}</div>}
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  if (!value) return "-";
  return value.replace("T", " ").replace(".000Z", "Z");
}

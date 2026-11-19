import { useMemo, useState } from "react";
import { ChevronRight, Globe, Plus, SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusDot, toneClass } from "@/components/surface";
import { originOf, outcomeOfMethod, requestLine, type Draft } from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

type Group = {
  origin: string;
  drafts: Draft[];
};

/**
 * TrafficList is the source list: requests grouped by target origin, with the
 * filter above and the newest outcome beside each request. A request row is
 * two lines — method and name, then the path — so the eye can find a target
 * without reading protocol text.
 */
export function TrafficList({
  drafts,
  selectedId,
  filter,
  onFilter,
  onSelect,
  onNew,
  t,
}: {
  drafts: Draft[];
  selectedId: string;
  filter: string;
  onFilter: (v: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  t: Dictionary;
}) {
  const groups = useMemo(() => groupDrafts(drafts, filter), [drafts, filter]);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const shown = groups.reduce((n, g) => n + g.drafts.length, 0);

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <h2 className="text-mini font-medium text-ink">{t.requests}</h2>
        <span className="proto text-ink-faint">{shown}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onNew}
          aria-label={t.newRequest}
          className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-rail-hover hover:text-ink"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="relative shrink-0 px-2 pb-2">
        <Input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder={t.filter}
          aria-label={t.filter}
          className="h-7 border-transparent bg-rail text-mini placeholder:text-ink-faint focus-visible:border-hairline focus-visible:ring-0"
        />
        <Kbd className="pointer-events-none absolute top-1.5 right-3.5 bg-transparent text-ink-faint">
          ⌘K
        </Kbd>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-2">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
              <SearchX className="size-4 text-ink-faint" />
              <p className="text-mini text-ink">{t.noMatch}</p>
              <p className="text-micro text-ink-faint">{t.noMatchHint}</p>
            </div>
          ) : (
            groups.map((group) => (
              <OriginGroup
                key={group.origin}
                group={group}
                selectedId={selectedId}
                folded={folded[group.origin] ?? false}
                onFold={() =>
                  setFolded((f) => ({
                    ...f,
                    [group.origin]: !(f[group.origin] ?? false),
                  }))
                }
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function OriginGroup({
  group,
  selectedId,
  folded,
  onFold,
  onSelect,
}: {
  group: Group;
  selectedId: string;
  folded: boolean;
  onFold: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onFold}
        aria-expanded={!folded}
        className="group flex h-6 items-center gap-1.5 px-3 text-micro text-ink-faint transition-colors hover:text-ink-muted"
      >
        <ChevronRight className={cn("size-3 transition-transform", !folded && "rotate-90")} />
        <Globe className="size-3" />
        <span className="truncate">{group.origin}</span>
        <span className="proto ml-auto tabular-nums">{group.drafts.length}</span>
      </button>
      {folded ? null : (
        <ul className="flex flex-col">
          {group.drafts.map((d) => (
            <li key={d.id}>
              <RequestRow
                draft={d}
                selected={d.id === selectedId}
                onSelect={() => onSelect(d.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RequestRow({
  draft,
  selected,
  onSelect,
}: {
  draft: Draft;
  selected: boolean;
  onSelect: () => void;
}) {
  const { method, path } = requestLine(draft.raw);
  const tone = outcomeOfMethod(method);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        "group flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-left transition-colors",
        selected ? "bg-rail-hover" : "hover:bg-rail-hover/60",
      )}
    >
      <StatusDot tone={tone} className="mt-1.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={cn("proto shrink-0 font-medium", toneClass[tone])}>{method}</span>
          <span className="truncate text-mini text-ink">{draft.name}</span>
        </span>
        <span className="truncate proto text-ink-faint">{path || "/"}</span>
      </span>
    </button>
  );
}

function groupDrafts(drafts: Draft[], filter: string): Group[] {
  const query = filter.trim().toLowerCase();
  const matches = drafts.filter((d) => {
    if (!query) return true;
    return `${d.name} ${d.target} ${d.raw}`.toLowerCase().includes(query);
  });
  const byOrigin = new Map<string, Draft[]>();
  for (const draft of matches) {
    const origin = originOf(draft.target);
    const list = byOrigin.get(origin);
    if (list) list.push(draft);
    else byOrigin.set(origin, [draft]);
  }
  return [...byOrigin.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([origin, drafts]) => ({ origin, drafts }));
}

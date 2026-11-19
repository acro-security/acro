import { ArrowUpRight, Layers, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, StatusDot, toneClass } from "@/components/surface";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/history-view";
import {
  duration,
  outcomeOf,
  outcomeOfMethod,
  requestLine,
  type Entry,
  type Outcome,
} from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * ContextView holds the snapshots a person deliberately kept, apart from the
 * session history: what a later agent run would read.
 */
export function ContextView({
  entries,
  onExport,
  onRemove,
  t,
}: {
  entries: Entry[];
  onExport: () => void;
  onRemove: (id: string) => void;
  t: Dictionary;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex h-8 shrink-0 items-center gap-2">
        <h2 className="text-title font-semibold tracking-tight">{t.contextTitle}</h2>
        <span className="proto tabular-nums text-ink-faint">{entries.length}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-ink-muted"
          disabled={!entries.length}
          onClick={onExport}
        >
          {t.export}
        </Button>
      </div>

      {entries.length > 0 ? (
        <p className="max-w-3xl text-mini text-muted-foreground">{t.contextEmptyHint}</p>
      ) : null}

      <Panel className="flex-1">
        {entries.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-4" />}
            title={t.contextEmpty}
            hint={t.contextEmptyHint}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col divide-y divide-hairline">
              {entries.map((item) => {
                const { method, path } = requestLine(item.draft.raw);
                const tone: Outcome = item.error ? "fail" : outcomeOf(item.result?.status);
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-rail/70"
                  >
                    <StatusDot tone={tone} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "proto shrink-0 font-medium",
                            toneClass[outcomeOfMethod(method)],
                          )}
                        >
                          {method || "GET"}
                        </span>
                        <span className="truncate text-mini text-ink">{item.draft.name}</span>
                      </span>
                      <span className="truncate proto text-ink-faint">
                        {item.draft.target}
                        {path}
                      </span>
                    </span>
                    {item.result ? (
                      <>
                        <span
                          className={cn(
                            "proto tabular-nums",
                            toneClass[outcomeOf(item.result.status)],
                          )}
                        >
                          {item.result.status}
                        </span>
                        <span className="proto w-16 text-right tabular-nums text-ink-faint">
                          {duration(item.result.durationMs)}
                        </span>
                      </>
                    ) : null}
                    <Button variant="ghost" size="icon" className="size-6 text-ink-muted" asChild>
                      <button
                        type="button"
                        aria-label={t.remove}
                        onClick={() => onRemove(item.id)}
                        className="size-6 text-ink-muted hover:text-fail"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </Button>
                    <span className="text-ink-faint" aria-hidden>
                      <ArrowUpRight className="size-3.5" />
                    </span>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </Panel>
    </div>
  );
}

import { ArrowLeftRight, ArrowUpRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, StatusDot, toneClass } from "@/components/surface";
import { ScrollArea } from "@/components/ui/scroll-area";
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
 * HistoryView is every request this session sent, newest first. It borrows the
 * source list's two-line row so traffic looks the same wherever it appears.
 */
export function HistoryView({
  history,
  onClear,
  onOpen,
  t,
}: {
  history: Entry[];
  onClear: () => void;
  onOpen: (entry: Entry) => void;
  t: Dictionary;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex h-8 shrink-0 items-center gap-2">
        <h2 className="text-title font-semibold tracking-tight">{t.history}</h2>
        <span className="proto tabular-nums text-ink-faint">{history.length}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-ink-muted"
          disabled={!history.length}
          onClick={onClear}
        >
          <Trash2 className="size-3.5" />
          {t.clear}
        </Button>
      </div>

      <Panel className="flex-1">
        {history.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight className="size-4" />}
            title={t.noHistory}
            hint={t.noHistoryHint}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col divide-y divide-hairline">
              {history.map((item) => (
                <li key={item.id}>
                  <EntryRow item={item} onOpen={() => onOpen(item)} t={t} />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </Panel>
    </div>
  );
}

function EntryRow({ item, onOpen, t }: { item: Entry; onOpen: () => void; t: Dictionary }) {
  const { method, path } = requestLine(item.draft.raw);
  const tone: Outcome = item.error ? "fail" : outcomeOf(item.result?.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-rail/70"
    >
      <StatusDot tone={tone} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className={cn("proto shrink-0 font-medium", toneClass[outcomeOfMethod(method)])}>
            {method || "GET"}
          </span>
          <span className="truncate text-mini text-ink">{item.draft.name}</span>
          <span className="truncate proto text-ink-faint">
            {item.draft.target}
            {path}
          </span>
        </span>
        <span className="proto text-ink-faint">
          {item.error ? t.failed : new Date(item.at).toLocaleTimeString()}
        </span>
      </span>
      {item.result ? (
        <>
          <span className={cn("proto tabular-nums", toneClass[outcomeOf(item.result.status)])}>
            {item.result.status}
          </span>
          <span className="proto w-16 text-right tabular-nums text-ink-faint">
            {duration(item.result.durationMs)}
          </span>
        </>
      ) : null}
      <span
        className="flex size-6 items-center justify-center rounded-sm text-ink-faint"
        aria-hidden
      >
        <ArrowUpRight className="size-3.5" />
      </span>
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
      <span className="text-ink-faint">{icon}</span>
      <p className="text-mini text-ink">{title}</p>
      <p className="max-w-64 text-micro text-ink-faint">{hint}</p>
      {action}
    </div>
  );
}

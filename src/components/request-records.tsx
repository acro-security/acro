import { ArrowUpRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, toneClass } from "@/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { duration, outcomeOf, outcomeOfMethod, requestLine, type Entry } from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

export function RequestRecords({
  entries,
  title,
  timestamp,
  openLabel,
  onOpen,
  onRemove,
  toolbar,
  empty,
  t,
}: {
  entries: Entry[];
  title: string;
  timestamp: string;
  openLabel: string;
  onOpen: (entry: Entry) => void;
  onRemove?: (id: string) => void;
  toolbar: React.ReactNode;
  empty: React.ReactNode;
  t: Dictionary;
}) {
  return (
    <Panel className="flex-1">
      <PanelHeader
        title={title}
        meta={<span className="proto text-ink-faint">{entries.length}</span>}
      >
        {toolbar}
      </PanelHeader>
      {!entries.length ? (
        empty
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[460px] table-fixed text-left">
            <thead className="sticky top-0 z-1 bg-strip text-xs font-medium text-ink-faint">
              <tr className="[&>th]:border-b [&>th]:px-3 [&>th]:py-2">
                <th>{t.request}</th>
                <th className="w-20">{t.status}</th>
                <th className="w-24">{t.duration}</th>
                <th className="w-28">{timestamp}</th>
                <th className="w-23 text-right">{t.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {entries.map((item) => {
                const { method, path } = requestLine(item.draft.raw);
                const date = onRemove ? (item.savedAt ?? item.at) : item.at;
                return (
                  <tr key={item.id} className="hover:bg-sidebar-accent/60 [&>td]:px-3 [&>td]:py-2">
                    <td>
                      <p className="truncate font-medium" title={item.draft.name}>
                        {item.draft.name}
                      </p>
                      <p className="truncate proto text-ink-faint" title={item.draft.target + path}>
                        <span className={toneClass[outcomeOfMethod(method)]}>
                          {method || "GET"}
                        </span>{" "}
                        {path}
                      </p>
                    </td>
                    <td
                      className={cn(
                        "proto whitespace-nowrap",
                        toneClass[item.error ? "fail" : outcomeOf(item.result?.status)],
                      )}
                      title={item.error || undefined}
                    >
                      {item.error ? t.failedShort : (item.result?.status ?? "—")}
                    </td>
                    <td className="proto text-ink-muted">
                      {item.result ? duration(item.result.durationMs) : "—"}
                    </td>
                    <td className="proto text-ink-muted">
                      <time dateTime={date}>{new Date(date).toLocaleTimeString()}</time>
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        {onRemove && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="quiet-icon"
                                size="icon-sm"
                                aria-label={t.remove}
                                onClick={() => onRemove(item.id)}
                              >
                                <Trash2 />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t.remove}</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="quiet-icon"
                              size="icon-sm"
                              aria-label={openLabel}
                              onClick={() => onOpen(item)}
                            >
                              <ArrowUpRight />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{openLabel}</TooltipContent>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

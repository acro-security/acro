import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n";
import { requestLine, type Draft } from "@/workspace";

export function RequestTabs({
  drafts,
  selectedId,
  onSelect,
  onClose,
  onCapture,
  onFind,
  children,
  t,
}: {
  drafts: Draft[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCapture: () => void;
  onFind: () => void;
  children: ReactNode;
  t: Dictionary;
}) {
  return (
    <Tabs
      value={drafts.some((d) => d.id === selectedId) ? selectedId : ""}
      onValueChange={onSelect}
      className="min-h-0 flex-1 gap-0 px-2 pt-3 pb-4 sm:px-4 lg:px-5"
    >
      <div className="flex h-[42px] min-w-0 shrink-0 items-center rounded-t-lg border bg-strip px-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList variant="editor" aria-label={t.openRequests}>
            {drafts.map((d) => (
              <div
                key={d.id}
                className="group/request-tab relative flex shrink-0 items-center"
                data-selected={selectedId === d.id}
              >
                <TabsTrigger
                  value={d.id}
                  title={`${d.target}\n${requestLine(d.raw).path}`}
                  className="max-w-60 min-w-36 pr-9"
                >
                  {d.captureNumber && (
                    <span className="proto text-ink-muted">#{d.captureNumber}</span>
                  )}
                  <span className="truncate">{d.name}</span>
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute right-1"
                  aria-label={`${t.closeRequest}: ${d.name}`}
                  onClick={() => onClose(d.id)}
                >
                  <X />
                </Button>
              </div>
            ))}
          </TabsList>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2">
          <Button variant="ghost" size="icon-xs" aria-label={t.findRequest} onClick={onFind}>
            <Search />
          </Button>
        </div>
      </div>
      {drafts.some((d) => d.id === selectedId) ? (
        <TabsContent value={selectedId} className="flex min-h-0 flex-1 flex-col">
          {children}
        </TabsContent>
      ) : (
        <Empty className="m-5 flex-1">
          <EmptyHeader>
            <EmptyTitle>{t.noOpenRequests}</EmptyTitle>
            <EmptyDescription>{t.reopenRequest}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button onClick={onCapture}>{t.capture}</Button>
              <Button variant="outline" onClick={onFind}>
                {t.findRequest}
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}
    </Tabs>
  );
}

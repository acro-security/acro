import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RequestRecords } from "@/components/request-records";
import type { Entry } from "@/workspace";
import type { Dictionary } from "@/i18n";

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
    <RequestRecords
      entries={history}
      title={t.history}
      timestamp={t.sentAt}
      openLabel={t.openInRepeater}
      onOpen={onOpen}
      t={t}
      toolbar={
        <Button variant="outline" size="sm" disabled={!history.length} onClick={onClear}>
          {t.clear}
        </Button>
      }
      empty={
        <EmptyState
          icon={<History className="size-8" />}
          title={t.noHistory}
          hint={t.noHistoryHint}
        />
      }
    />
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

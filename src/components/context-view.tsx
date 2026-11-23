import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/history-view";
import { RequestRecords } from "@/components/request-records";
import type { Entry } from "@/workspace";
import type { Dictionary } from "@/i18n";

export function ContextView({
  entries,
  onExport,
  onOpen,
  onRemove,
  t,
}: {
  entries: Entry[];
  onExport: () => void;
  onOpen: (entry: Entry) => void;
  onRemove: (id: string) => void;
  t: Dictionary;
}) {
  return (
    <RequestRecords
      entries={entries}
      title={t.context}
      timestamp={t.savedAt}
      openLabel={t.openInRepeater}
      onOpen={onOpen}
      onRemove={onRemove}
      t={t}
      toolbar={
        <Button variant="outline" size="sm" disabled={!entries.length} onClick={onExport}>
          {t.export}
        </Button>
      }
      empty={
        <EmptyState
          icon={<Layers className="size-8" />}
          title={t.contextEmpty}
          hint={t.contextEmptyHint}
        />
      }
    />
  );
}

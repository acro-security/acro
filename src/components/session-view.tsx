import { Download, Layers } from "lucide-react";
import { Panel, PanelHeader } from "@/components/surface";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Dictionary } from "@/i18n";
import type { SessionDraft } from "@/workspace";

/** Locally persisted task preparation, without simulated model replies. */
export function SessionView({
  session,
  projectName,
  onChange,
  onExport,
  onEvidence,
  evidenceCount,
  t,
}: {
  session: SessionDraft;
  projectName: string;
  onChange: (patch: Partial<SessionDraft>) => void;
  onExport: () => void;
  onEvidence: () => void;
  evidenceCount: number;
  t: Dictionary;
}) {
  return (
    <Panel className="mx-auto w-full max-w-[800px] shrink-0">
      <PanelHeader
        title={t.sessionDraft}
        meta={<span className="text-mini text-ink-muted">{t.modelNotConnected}</span>}
      >
        <Button variant="outline" size="sm" onClick={onExport}>
          <Download data-icon="inline-start" />
          {t.exportSession}
        </Button>
      </PanelHeader>
      <FieldGroup className="p-4">
        <Field>
          <FieldLabel htmlFor="session-title">{t.sessionTitle}</FieldLabel>
          <Input
            id="session-title"
            value={session.title}
            onChange={(e) => onChange({ title: e.target.value })}
            maxLength={100}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="session-instructions">{t.instructions}</FieldLabel>
          <Textarea
            id="session-instructions"
            value={session.instructions}
            onChange={(e) => onChange({ instructions: e.target.value })}
            placeholder={t.instructionsPlaceholder}
            className="min-h-60 resize-y"
          />
          <FieldDescription>{t.localDraftHint}</FieldDescription>
        </Field>
        <Field orientation="responsive" className="rounded-md border p-3">
          <div className="flex flex-1 flex-col gap-1">
            <FieldLabel>{t.projectEvidence}</FieldLabel>
            <FieldDescription>
              {projectName} · {evidenceCount} {t.snapshots}
            </FieldDescription>
          </div>
          <Button variant="outline" aria-label={t.context} onClick={onEvidence}>
            <Layers data-icon="inline-start" />
            {t.viewEvidence}
          </Button>
        </Field>
      </FieldGroup>
    </Panel>
  );
}

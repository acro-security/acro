import { Download, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Dictionary } from "@/i18n";
import type { SessionDraft } from "@/workspace";

/** Locally persisted task preparation, without simulated model replies. */
export function SessionView({
  session,
  onChange,
  onExport,
  onEvidence,
  evidenceCount,
  t,
}: {
  session: SessionDraft;
  onChange: (patch: Partial<SessionDraft>) => void;
  onExport: () => void;
  onEvidence: () => void;
  evidenceCount: number;
  t: Dictionary;
}) {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 px-5 py-8 lg:py-12">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">{t.sessionDraft}</h1>
        <Badge variant="secondary">{t.modelNotConnected}</Badge>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onExport}>
          <Download data-icon="inline-start" />
          {t.exportSession}
        </Button>
      </div>
      <FieldGroup>
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
        <Field orientation="horizontal">
          <div className="flex flex-1 flex-col gap-1">
            <FieldLabel>{t.projectEvidence}</FieldLabel>
            <FieldDescription>{t.sessionEvidenceHint}</FieldDescription>
          </div>
          <Button variant="outline" aria-label={t.context} onClick={onEvidence}>
            <Layers data-icon="inline-start" />
            {evidenceCount}
          </Button>
        </Field>
      </FieldGroup>
    </section>
  );
}

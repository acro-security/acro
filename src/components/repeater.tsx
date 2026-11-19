import { useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Copy,
  Download,
  Layers,
  SendHorizontal,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CodeView } from "@/components/code-view";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Panel, PanelHeader, StatusDot, toneClass } from "@/components/surface";
import {
  byteSize,
  duration,
  outcomeOf,
  outcomeOfMethod,
  responseText,
  type Draft,
  type Entry,
} from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Repeater is the workbench itself: a request and the response it produced,
 * side by side. The request is edited as raw HTTP, because that is the artifact
 * a reader of traffic already knows how to write.
 */
export function Repeater({
  draft,
  entry,
  busy,
  onChange,
  onSend,
  onCancel,
  onDelete,
  onCollect,
  onSaveResponse,
  t,
}: {
  draft: Draft;
  entry?: Entry;
  busy: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onSend: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onCollect: () => void;
  onSaveResponse: () => void;
  t: Dictionary;
}) {
  const [tab, setTab] = useState<"body" | "headers" | "raw">("body");
  const [requestPretty, setRequestPretty] = useState(false);
  const [pretty, setPretty] = useState(true);
  const [wrap, setWrap] = useState(true);
  const result = entry?.result;
  const text = result ? responseText(result, tab, false) : "";
  const method = draft.raw.trim().split(/\s+/)[0]?.toUpperCase() || "GET";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RequestBar
        draft={draft}
        method={method}
        busy={busy}
        onChange={onChange}
        onSend={onSend}
        onCancel={onCancel}
        onDelete={onDelete}
        t={t}
      />

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-cols-2 lg:grid-rows-1">
        <Panel>
          <PanelHeader title={t.request}>
            <CopyAction label={t.copy} value={draft.raw} />
          </PanelHeader>
          <div className="flex h-6 shrink-0 items-center gap-2 border-b border-hairline bg-rail/60 px-3">
            <Option checked={requestPretty} onCheck={setRequestPretty} label={t.pretty} />
            <span className="proto ml-auto text-ink-faint">HTTP/1.1</span>
          </div>
          {requestPretty ? (
            <CodeView text={draft.raw} http />
          ) : (
            <Textarea
              value={draft.raw}
              onChange={(e) => onChange({ raw: e.target.value })}
              spellCheck={false}
              aria-label={t.request}
              className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 message-code text-ink shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          )}
        </Panel>

        <Panel>
          <PanelHeader title={t.response}>
            <IconAction
              label={t.collect}
              icon={<Layers className="size-3.5" />}
              disabled={!result}
              onClick={onCollect}
            />
            <CopyAction label={t.copy} value={text} disabled={!result} />
            <IconAction
              label={t.saveResponse}
              icon={<Download className="size-3.5" />}
              disabled={!result}
              onClick={onSaveResponse}
            />
          </PanelHeader>

          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline bg-rail/60 px-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
              <TabsList className="h-7 bg-transparent p-0">
                <TabsTrigger value="body" className="h-6 px-2 text-micro">
                  {t.body}
                </TabsTrigger>
                <TabsTrigger value="headers" className="h-6 px-2 text-micro">
                  {t.headers}
                </TabsTrigger>
                <TabsTrigger value="raw" className="h-6 px-2 text-micro">
                  {t.raw}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="ml-auto flex items-center gap-2">
              {result ? <StatusChip status={result.status} /> : null}
            </div>
          </div>

          {result ? (
            <>
              <CodeView
                text={text}
                pretty={pretty}
                wrap={wrap}
                http={tab === "raw"}
                mime={
                  tab === "headers"
                    ? "text/plain"
                    : result.headers.find((h) => h.name.toLowerCase() === "content-type")?.value
                }
                encoding={tab === "headers" ? undefined : result.encoding}
                compression={
                  tab === "headers"
                    ? undefined
                    : result.headers.find((h) => h.name.toLowerCase() === "content-encoding")?.value
                }
              />
              {result.truncated ? (
                <p className="border-t border-hairline px-3 py-1 text-micro text-ink-faint">
                  {t.truncation}
                </p>
              ) : null}
              {result.encoding === "base64" ? (
                <p className="border-t border-hairline px-3 py-1 text-micro text-ink-faint">
                  {t.binary}
                </p>
              ) : null}
            </>
          ) : entry?.error ? (
            <div className="flex flex-1 flex-col gap-2 overflow-auto p-4">
              <p className="text-mini font-medium text-fail">{t.failed}</p>
              <p className="proto whitespace-pre-wrap break-words text-fail/90">{entry.error}</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <ArrowLeftRight className="size-5 text-ink-faint" />
              <p className="text-mini text-ink">{t.noResponse}</p>
              <p className="max-w-56 text-micro text-ink-faint">{t.noResponseHint}</p>
            </div>
          )}

          <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-hairline bg-rail/60 px-3">
            <Option checked={pretty} onCheck={setPretty} label={t.pretty} />
            <Option checked={wrap} onCheck={setWrap} label={t.wrap} />
            {result ? (
              <span className="proto ml-auto tabular-nums text-ink-faint">
                {duration(result.durationMs)} · {byteSize(result.size)}
              </span>
            ) : null}
          </footer>
        </Panel>
      </div>
    </div>
  );
}

function RequestBar({
  draft,
  method,
  busy,
  onChange,
  onSend,
  onCancel,
  onDelete,
  t,
}: {
  draft: Draft;
  method: string;
  busy: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onSend: () => void;
  onCancel: () => void;
  onDelete: () => void;
  t: Dictionary;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t.rename}
          maxLength={100}
          className="h-8 min-w-0 flex-1 border-hairline bg-panel text-body focus-visible:border-hairline focus-visible:ring-0"
        />
        <IconAction label={t.delete} icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "proto flex h-8 w-14 shrink-0 items-center justify-center rounded-md border border-hairline font-medium",
            toneClass[outcomeOfMethod(method)],
          )}
          aria-label={t.method}
        >
          {method}
        </span>
        <Input
          value={draft.target}
          onChange={(e) => onChange({ target: e.target.value })}
          aria-label={t.target}
          placeholder="https://example.com"
          className="h-8 min-w-0 flex-1 border-hairline bg-panel proto focus-visible:border-hairline focus-visible:ring-0"
        />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t.options}>
              <Settings2 />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <RequestOptions draft={draft} onChange={onChange} t={t} />
          </PopoverContent>
        </Popover>
        {busy ? (
          <Button variant="outline" size="sm" className="h-8 w-full sm:w-28" onClick={onCancel}>
            <X className="size-3.5" />
            {t.cancel}
          </Button>
        ) : (
          <Button size="sm" className="h-8 w-full sm:w-28" onClick={onSend}>
            <SendHorizontal className="size-3.5" />
            {t.send}
          </Button>
        )}
      </div>
    </div>
  );
}

function RequestOptions({
  draft,
  onChange,
  t,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  t: Dictionary;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-mini text-ink">
        <Checkbox
          checked={draft.followRedirects}
          onCheckedChange={(v) => onChange({ followRedirects: v === true })}
        />
        {t.redirects}
      </label>
      <span className="text-mini text-ink-muted">{t.timeout}</span>
      <Input
        type="number"
        min={1}
        max={120}
        value={draft.timeoutSeconds}
        onChange={(e) => onChange({ timeoutSeconds: Number(e.target.value) || 30 })}
        aria-label={t.timeout}
        className="h-7 w-16 bg-canvas proto text-center focus-visible:border-hairline focus-visible:ring-0"
      />
      <span className="text-micro text-ink-faint">{t.seconds}</span>
    </div>
  );
}

function StatusChip({ status }: { status: number }) {
  return (
    <span
      className={cn("proto flex items-center gap-1.5 font-medium", toneClass[outcomeOf(status)])}
    >
      <StatusDot tone={outcomeOf(status)} />
      {status}
    </span>
  );
}

function Option({
  checked,
  onCheck,
  label,
}: {
  checked: boolean;
  onCheck: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-micro text-ink-muted">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheck(v === true)}
        className="size-3.5"
      />
      {label}
    </label>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  disabled,
  active,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn("size-6 text-ink-muted", active && "bg-rail-hover text-ink")}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CopyAction({
  label,
  value,
  disabled,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="size-6 text-ink-muted"
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

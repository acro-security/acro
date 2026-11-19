import { useMemo, useState } from "react";
import { ArrowLeftRight, Play, ShieldCheck, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, StatusDot, toneClass } from "@/components/surface";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { capture, type Settings, type Traffic } from "@/capture";
import { duration, byteSize, outcomeOf, outcomeOfMethod, type Outcome } from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CodeView } from "@/components/code-view";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

/**
 * CaptureView is the proxy: it shows whether Acro is intercepting, what a client
 * must do to trust it, and every exchange as it arrives.
 */
export function CaptureView({
  traffic,
  settings,
  onSettings,
  filter,
  onReplay,
  onClear,
  t,
}: {
  traffic: Traffic[];
  settings: Settings;
  onSettings: (settings: Settings) => void;
  filter: string;
  onReplay: (item: Traffic) => void;
  onClear: () => void;
  t: Dictionary;
}) {
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("all");
  const [dialog, setDialog] = useState<Traffic | null>(null);

  const origins = useMemo(() => {
    const set = new Set<string>();
    for (const item of traffic) {
      try {
        set.add(new URL(item.url).origin);
      } catch {
        /* a CONNECT failure may not parse */
      }
    }
    return [...set].sort();
  }, [traffic]);

  const query = filter.trim().toLowerCase();
  const shown = traffic.filter((item) => {
    if (origin !== "all") {
      try {
        if (new URL(item.url).origin !== origin) return false;
      } catch {
        return false;
      }
    }
    if (!query) return true;
    return `${item.sequence} ${item.method} ${item.url} ${item.status}`
      .toLowerCase()
      .includes(query);
  });

  async function toggle() {
    setBusy(true);
    try {
      const next = settings.running ? await capture.stop() : await capture.start();
      onSettings(next);
      if (next.error) toast.error(next.error);
      else if (next.running) toast.success(`${t.captureListening} ${next.addr}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function downloadCA() {
    try {
      const pem = await capture.certificate();
      const url = URL.createObjectURL(new Blob([pem], { type: "application/x-pem-file" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "acro-ca.pem";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2">
        <h2 className="text-title font-semibold tracking-tight">{t.capture}</h2>
        <span
          className={cn(
            "proto inline-flex h-5 items-center gap-1.5 rounded-sm border border-hairline px-1.5 text-micro",
            settings.running ? "text-ok" : "text-ink-faint",
          )}
        >
          <StatusDot tone={settings.running ? "ok" : "muted"} />
          {settings.running ? t.captureOn : t.captureOff}
        </span>
        {settings.running ? (
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(settings.addr)}
            title={settings.addr}
            className="proto truncate text-micro text-ink-muted hover:text-ink"
          >
            {settings.addr}
          </button>
        ) : null}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-ink-muted"
              aria-label={t.captureCertificate}
              onClick={() => void downloadCA()}
            >
              <ShieldCheck className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.captureCertificate}</TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          variant={settings.running ? "outline" : "default"}
          className="h-7"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {settings.running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
          {settings.running ? t.captureStop : t.captureStart}
        </Button>
      </div>

      {settings.running ? (
        <p className="text-micro text-ink-faint">
          {t.captureHint} <span className="proto">{settings.addr}</span>
        </p>
      ) : (
        <p className="text-micro text-ink-faint">{t.captureStartHint}</p>
      )}

      <Panel className="flex-1">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <span className="text-micro text-ink-muted">
            {t.captureTraffic} {traffic.length}
          </span>
          <div className="flex-1" />
          {origins.length > 0 ? (
            <Select value={origin} onValueChange={setOrigin}>
              <SelectTrigger
                aria-label={t.target}
                className="h-6 w-auto gap-1 border-transparent bg-transparent px-1.5 text-micro"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="all" className="text-mini">
                    {t.allOrigins}
                  </SelectItem>
                  {origins.map((o) => (
                    <SelectItem key={o} value={o} className="text-mini">
                      {o}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.clear}
            className="size-6 text-ink-muted"
            disabled={!traffic.length}
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        {shown.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
            <ArrowLeftRight className="size-4 text-ink-faint" />
            <p className="text-mini text-ink">
              {settings.running ? t.captureEmpty : t.captureEmptyOff}
            </p>
            <p className="max-w-64 text-micro text-ink-faint">
              {settings.running ? t.captureEmptyHint : t.captureStartHint}
            </p>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col divide-y divide-hairline">
              {shown.map((item) => (
                <TrafficRow
                  key={item.id}
                  item={item}
                  onOpen={() => {
                    setDialog(item);
                  }}
                  onReplay={() => onReplay(item)}
                  t={t}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </Panel>

      {dialog ? <TrafficDialog item={dialog} onClose={() => setDialog(null)} t={t} /> : null}
    </div>
  );
}

function TrafficRow({
  item,
  onOpen,
  onReplay,
  t,
}: {
  item: Traffic;
  onOpen: () => void;
  onReplay: () => void;
  t: Dictionary;
}) {
  const tone: Outcome = item.error ? "fail" : outcomeOf(item.status);
  const { path, origin } = splitURL(item.url);
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-rail/70"
          >
            <span className="proto w-12 shrink-0 text-ink-muted">#{item.sequence}</span>
            <StatusDot tone={tone} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "proto shrink-0 font-medium",
                    toneClass[outcomeOfMethod(item.method)],
                  )}
                >
                  {item.method}
                </span>
                <span className="truncate proto text-ink">{origin}</span>
                <span className="truncate proto text-ink-faint">{path}</span>
              </span>
              <span className="proto text-ink-faint">
                {item.error ? t.failed : new Date(item.at).toLocaleTimeString()} ·{" "}
                {item.truncated ? t.truncation : item.contentType || "—"}
              </span>
            </span>
            {item.error ? (
              <span className="max-w-64 truncate text-micro text-fail" title={item.error}>
                {item.error}
              </span>
            ) : (
              <>
                <span className={cn("proto tabular-nums", toneClass[outcomeOf(item.status)])}>
                  {item.status}
                </span>
                <span className="proto w-16 text-right tabular-nums text-ink-faint">
                  {duration(item.durationMs)}
                </span>
                <span className="proto w-14 text-right tabular-nums text-ink-faint">
                  {byteSize(item.size)}
                </span>
              </>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuItem onSelect={onReplay}>{t.sendToRepeater}</ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** TrafficDialog shows one captured exchange: request above, response below. */
function TrafficDialog({
  item,
  onClose,
  t,
}: {
  item: Traffic;
  onClose: () => void;
  t: Dictionary;
}) {
  const [pretty, setPretty] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="fixed inset-y-3 right-3 left-auto top-3 flex h-[calc(100dvh-1.5rem)] w-[min(64rem,calc(100vw-1.5rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">
          {t.request} #{item.sequence}
        </DialogTitle>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <span className="proto shrink-0">#{item.sequence}</span>
          <span className="truncate proto">
            {item.method} {item.url}
          </span>
          <span className="proto ml-auto">{item.status || "—"}</span>
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={pretty} onCheckedChange={(v) => setPretty(v === true)} />
            {t.pretty}
          </label>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t.close}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <h3 className="border-b px-3 py-2 text-xs text-muted-foreground">{t.request}</h3>
          <div className="flex min-h-40 shrink-0 flex-col">
            <CodeView
              text={item.requestHttp}
              encoding={item.requestEncoding}
              http
              pretty={pretty}
            />
          </div>
          <h3 className="border-y px-3 py-2 text-xs text-muted-foreground">{t.response}</h3>
          {item.error ? (
            <p className="message-code p-3 text-fail">{item.error}</p>
          ) : (
            <div className="flex min-h-40 flex-1 flex-col">
              <CodeView text={item.responseHttp} encoding={item.encoding} http pretty={pretty} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function splitURL(url: string): { origin: string; path: string } {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname + u.search };
  } catch {
    return { origin: url, path: "" };
  }
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, StatusDot, toneClass } from "@/components/surface";
import { Group, Panel as ResizePanel, Separator } from "react-resizable-panels";
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
import { duration, outcomeOf, outcomeOfMethod, type Outcome } from "@/workspace";
import type { Dictionary } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "@/components/ui/context-menu";
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
  const [selected, setSelected] = useState<Traffic | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [pretty, setPretty] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(0);

  useEffect(() => {
    if (!selected) return;
    function closeDetails(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
      ) {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", closeDetails);
    return () => window.removeEventListener("keydown", closeDetails);
  }, [selected]);

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

  const active = selected && shown.some((item) => item.id === selected.id) ? selected : null;
  const showDetails = !!active && expanded;

  useLayoutEffect(() => {
    const list = viewport.current;
    const content = table.current;
    if (!list || !content) return;
    function updateEdges() {
      if (!list) return;
      scrollPosition.current = list.scrollTop;
      list.dataset.above = String(list.scrollTop > 0);
      list.dataset.below = String(list.scrollHeight - list.clientHeight - list.scrollTop > 1);
    }
    list.scrollTop = scrollPosition.current;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(list);
    observer.observe(content);
    list.addEventListener("scroll", updateEdges, { passive: true });
    updateEdges();
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", updateEdges);
    };
  }, [shown.length > 0, showDetails]);

  return (
    <Panel className="flex-1">
      <header
        aria-label={t.capture}
        className="flex min-h-[42px] shrink-0 flex-wrap items-center gap-2 border-b bg-strip px-3 py-1"
      >
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-body",
            settings.running ? "text-ok" : "text-muted-foreground",
          )}
        >
          <StatusDot tone={settings.running ? "ok" : "muted"} />
          {settings.running ? t.captureOn : t.captureOff}
        </span>
        {settings.running && (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(settings.addr).catch(() => {})}
            title={settings.addr}
            className="proto text-ink-muted hover:text-ink"
          >
            {settings.addr}
          </button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {settings.running ? t.captureStop : t.captureStart}
        </Button>
      </header>
      <div className="flex min-h-[42px] shrink-0 items-center gap-2 border-b bg-strip px-3 py-1">
        <Select
          value={origins.includes(origin) ? origin : "all"}
          onValueChange={(value) => {
            scrollPosition.current = 0;
            viewport.current?.scrollTo({ top: 0 });
            setOrigin(value);
            setSelected(null);
          }}
        >
          <SelectTrigger aria-label={t.target} className="h-7 max-w-[48%] bg-field text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectItem value="all">{t.allOrigins}</SelectItem>
              {origins.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-mini text-muted-foreground">
          {t.captureTraffic} {traffic.length}
        </span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="quiet-icon"
              size="icon-sm"
              aria-label={t.clear}
              disabled={!traffic.length}
              onClick={() => {
                setSelected(null);
                setOrigin("all");
                onClear();
              }}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.clear}</TooltipContent>
        </Tooltip>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <ArrowLeftRight className="size-8 text-ink-faint" />
          <p className="text-title font-semibold">
            {settings.running ? t.captureEmpty : t.captureEmptyOff}
          </p>
          <p className="max-w-64 text-mini text-ink-muted">
            {settings.running ? t.captureEmptyHint : t.captureStartHint}
          </p>
        </div>
      ) : (
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          key={showDetails ? "split" : "list"}
        >
          <ResizePanel
            defaultSize={showDetails ? "36%" : "100%"}
            minSize="76px"
            className="min-h-0"
          >
            <div ref={viewport} className="capture-scroll h-full overflow-auto">
              <div ref={table} role="table" aria-label={t.captureTraffic} className="capture-table">
                <div role="row" className="capture-columns capture-table-head">
                  {[t.captureId, t.method, t.domain, t.endpoint, t.status, t.duration].map(
                    (label) => (
                      <span key={label} role="columnheader">
                        {label}
                      </span>
                    ),
                  )}
                </div>
                {shown.map((item) => (
                  <TrafficRow
                    key={item.id}
                    item={item}
                    selected={item.id === active?.id}
                    onOpen={() => {
                      setSelected(item);
                      setExpanded(true);
                    }}
                    onReplay={() => onReplay(item)}
                    t={t}
                  />
                ))}
              </div>
            </div>
          </ResizePanel>
          {active && (
            <>
              <Separator
                disabled={!showDetails}
                aria-label={t.resizeCapture}
                className={cn("capture-divider", !showDetails && "pointer-events-none opacity-0")}
              />
              <ResizePanel
                defaultSize={showDetails ? "64%" : "42px"}
                minSize={showDetails ? "120px" : "42px"}
                maxSize={showDetails ? undefined : "42px"}
              >
                <section
                  className="flex h-full min-h-0 flex-col"
                  aria-label={`${t.request} #${active.sequence}`}
                >
                  <header className="flex h-[42px] shrink-0 items-center gap-2 border-b bg-strip px-3">
                    <Button
                      variant="quiet-icon"
                      size="icon-sm"
                      aria-expanded={expanded}
                      aria-label={expanded ? t.collapseCapture : t.expandCapture}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      <ChevronDown className={cn(!expanded && "-rotate-90")} />
                    </Button>
                    <span className="proto shrink-0">#{active.sequence}</span>
                    <span className="truncate proto text-ink-muted">
                      {active.method} {splitURL(active.url).path}
                    </span>
                    <div className="flex-1" />
                    {expanded && (
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox checked={pretty} onCheckedChange={(v) => setPretty(v === true)} />
                        {t.pretty}
                      </label>
                    )}
                    <Button
                      variant="quiet-icon"
                      size="icon-sm"
                      aria-label={t.close}
                      title={t.close}
                      onClick={() => setSelected(null)}
                    >
                      <X />
                    </Button>
                  </header>
                  {expanded && (
                    <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 p-3 lg:grid-cols-2 lg:grid-rows-1">
                      <Panel>
                        <PanelHeader title={t.request} />
                        <CodeView
                          text={active.requestHttp}
                          encoding={active.requestEncoding}
                          http
                          pretty={pretty}
                        />
                      </Panel>
                      <Panel>
                        <PanelHeader title={t.response}>
                          <span
                            className={cn(
                              "proto",
                              toneClass[active.error ? "fail" : outcomeOf(active.status)],
                            )}
                          >
                            {active.status || "—"}
                          </span>
                        </PanelHeader>
                        {active.error ? (
                          <p className="message-code overflow-auto p-3 text-fail">{active.error}</p>
                        ) : (
                          <CodeView
                            text={active.responseHttp}
                            encoding={active.encoding}
                            http
                            pretty={pretty}
                          />
                        )}
                      </Panel>
                    </div>
                  )}
                </section>
              </ResizePanel>
            </>
          )}
        </Group>
      )}
    </Panel>
  );
}

function TrafficRow({
  item,
  selected,
  onOpen,
  onReplay,
  t,
}: {
  item: Traffic;
  selected: boolean;
  onOpen: () => void;
  onReplay: () => void;
  t: Dictionary;
}) {
  const tone: Outcome = item.error ? "fail" : outcomeOf(item.status);
  const { domain, path } = splitURL(item.url);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="row" className="capture-columns capture-table-row" data-selected={selected}>
          <span role="cell" className="text-ink-muted">
            #{item.sequence}
          </span>
          <span role="cell" className={toneClass[outcomeOfMethod(item.method)]}>
            {item.method}
          </span>
          <span role="cell" className="truncate text-ink-muted" title={domain}>
            {domain}
          </span>
          <span role="cell" className="min-w-0">
            <button
              type="button"
              className="capture-open truncate"
              aria-pressed={selected}
              aria-label={`#${item.sequence} ${item.method} ${domain} ${path}`}
              title={item.url}
              onClick={onOpen}
            >
              {path}
            </button>
          </span>
          <span
            role="cell"
            className={cn("truncate whitespace-nowrap", toneClass[tone])}
            title={item.error || undefined}
          >
            {item.error ? t.failedShort : item.status}
          </span>
          <span role="cell" className="text-ink-muted">
            {duration(item.durationMs)}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onSelect={onReplay}>{t.sendToRepeater}</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function splitURL(url: string) {
  try {
    const u = new URL(url);
    return { domain: u.host, path: u.pathname + u.search };
  } catch {
    return { domain: url, path: "/" };
  }
}

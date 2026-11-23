import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  FolderClock,
  Layers,
  Monitor,
  Moon,
  PanelLeftOpen,
  PanelLeftClose,
  PanelRight,
  Minus,
  Square,
  X,
  Languages,
  Search,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserView } from "@/components/browser-view";
import { Repeater } from "@/components/repeater";
import { HistoryView } from "@/components/history-view";
import { ContextView } from "@/components/context-view";
import { CaptureView } from "@/components/capture-view";
import { RequestTabs } from "@/components/request-tabs";
import { WorkspaceSidebar, type WorkbenchView } from "@/components/workspace-sidebar";
import { SessionView } from "@/components/session-view";
import { capture, type Settings, type Traffic } from "@/capture";
import { StatusDot, toneClass } from "@/components/surface";
import { dictionaries, locales, type Locale } from "@/i18n";
import { native, send } from "@/api";
import { currentWindow } from "mygo-runtime";
import wordmark from "@/assets/acro-wordmark.dark.svg";
import {
  freshWorkspace,
  loadWorkspace,
  MAX_ENTRIES,
  newId,
  originOf,
  outcomeOfMethod,
  requestLine,
  saveWorkspace,
  type Draft,
  type Entry,
  type SessionDraft,
} from "@/workspace";
import { Select as SelectPrimitive } from "radix-ui";
import { draftFromTraffic } from "@/lib/capture-draft";
import { cn } from "@/lib/utils";

const initial = loadWorkspace() ?? freshWorkspace();

export function App() {
  const [workspace, setWorkspace] = useState(initial);
  const [view, setView] = useState<WorkbenchView>(
    initial.selectedSessionId ? "session" : initial.drafts.length ? "repeater" : "capture",
  );
  const [openedEntry, setOpenedEntry] = useState<Entry | null>(null);
  const [history, setHistory] = useState<Entry[]>([]);
  const [context, setContext] = useState<Entry[]>([]);
  const [traffic, setTraffic] = useState<Traffic[]>([]);
  const captureHistoryRequest = useRef<Promise<Traffic[]> | null>(null);
  const captureHistoryLoaded = useRef(false);
  const [captureSettings, setCaptureSettings] = useState<Settings>({
    running: false,
    addr: "",
    port: 8081,
    captured: 0,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [palette, setPalette] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 767px)").matches);
  const [showVault, setShowVault] = useState(true);
  const [sidebar, setSidebar] = useState(() => !matchMedia("(max-width: 767px)").matches);
  const running = useRef<AbortController | null>(null);
  const {
    locale,
    appearance,
    selectedId,
    selectedProjectId: projectId,
    selectedSessionId: sessionId,
  } = workspace;
  const t = dictionaries[locale];
  const project = workspace.projects.find((p) => p.id === projectId);
  const drafts = workspace.drafts.filter((d) => d.projectId === projectId);
  const openDrafts = workspace.openRequestIds
    .map((id) => drafts.find((d) => d.id === id))
    .filter((d) => !!d);
  const draft = drafts.find((d) => d.id === selectedId) ?? drafts[0];
  const projectHistory = history.filter((e) => e.draft.projectId === projectId);
  const projectContext = context.filter((e) => e.draft.projectId === projectId);
  const entry =
    openedEntry?.draft.id === draft?.id
      ? (openedEntry ?? undefined)
      : projectHistory.find((e) => e.draft.id === draft?.id);
  const session = workspace.sessions.find((s) => s.id === sessionId && s.projectId === projectId);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        appearance === "dark" || (appearance === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const apply = () => {
      setNarrow(media.matches);
      setSidebar(!media.matches);
    };
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  useEffect(() => saveWorkspace(workspace), [workspace]);
  useEffect(() => () => running.current?.abort(), []);

  // The proxy streams what it captures, so the list grows as traffic arrives.
  useEffect(() => {
    let disposed = false;
    let liveState = false;
    const stop = capture.watch(
      (item) => {
        if (!disposed)
          setTraffic((list) => [item, ...list.filter((old) => old.id !== item.id)].slice(0, 500));
      },
      (state) => {
        liveState = true;
        if (!disposed) setCaptureSettings(state);
      },
    );
    void capture
      .status()
      .then((state) => {
        if (!disposed && !liveState) setCaptureSettings(state);
      })
      .catch((error) => {
        if (!disposed) toast.error(String(error));
      });
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  useEffect(() => {
    if (view !== "capture" || captureHistoryLoaded.current) return;
    let disposed = false;
    const request = (captureHistoryRequest.current ??= capture.history());
    void request
      .then((items) => {
        if (disposed || captureHistoryRequest.current !== request) return;
        captureHistoryRequest.current = null;
        captureHistoryLoaded.current = true;
        setTraffic((list) => {
          const seen = new Set(list.map((item) => item.id));
          return [
            ...list,
            ...items
              .slice()
              .reverse()
              .filter((item) => !seen.has(item.id)),
          ].slice(0, 500);
        });
      })
      .catch((error) => {
        if (captureHistoryRequest.current === request) captureHistoryRequest.current = null;
        if (!disposed) toast.error(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((p) => !p);
      }
      if (
        event.key === "Enter" &&
        view === "repeater" &&
        draft &&
        workspace.openRequestIds.includes(draft.id)
      ) {
        event.preventDefault();
        if (running.current) running.current.abort();
        else void run(draft);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function navigate(target: WorkbenchView) {
    setView(target);
    if (target !== "session")
      setWorkspace((ws) => (ws.selectedSessionId ? { ...ws, selectedSessionId: null } : ws));
    if (narrow) setSidebar(false);
  }
  function openRequest(id: string) {
    setWorkspace((ws) => {
      const found = ws.drafts.find((d) => d.id === id);
      if (!found) return ws;
      return {
        ...ws,
        selectedId: id,
        selectedProjectId: found.projectId,
        openRequestIds: ws.openRequestIds.includes(id)
          ? ws.openRequestIds
          : [...ws.openRequestIds, id],
      };
    });
    navigate("repeater");
  }
  function replayCapture(item: Traffic) {
    try {
      const created = draftFromTraffic(item, projectId);
      setWorkspace((ws) => ({
        ...ws,
        drafts: ws.drafts.some((d) => d.id === created.id) ? ws.drafts : [...ws.drafts, created],
        selectedId: created.id,
        selectedProjectId: ws.drafts.find((d) => d.id === created.id)?.projectId ?? projectId,
        openRequestIds: ws.openRequestIds.includes(created.id)
          ? ws.openRequestIds
          : [...ws.openRequestIds, created.id],
      }));
      navigate("repeater");
    } catch (error) {
      toast.error(String(error));
    }
  }
  function closeRequest(id: string) {
    setWorkspace((ws) => {
      const opened = ws.openRequestIds.filter((key) => key !== id);
      const siblings = ws.openRequestIds.filter((key) =>
        ws.drafts.some((d) => d.id === key && d.projectId === projectId),
      );
      const index = siblings.indexOf(id);
      const next = siblings[index + 1] ?? siblings[index - 1];
      return {
        ...ws,
        openRequestIds: opened,
        selectedId: ws.selectedId === id ? (next ?? ws.selectedId) : ws.selectedId,
      };
    });
  }
  function patchDraft(patch: Partial<Draft>) {
    setWorkspace((ws) => ({
      ...ws,
      drafts: ws.drafts.map((d) => (d.id === draft?.id ? { ...d, ...patch } : d)),
    }));
  }
  function deleteRequest() {
    setWorkspace((ws) => {
      const all = ws.drafts.filter((d) => d.id !== draft?.id);
      const opened = ws.openRequestIds.filter((id) => id !== draft?.id);
      return {
        ...ws,
        drafts: all,
        selectedId: all.find((d) => d.projectId === projectId && opened.includes(d.id))?.id ?? "",
        openRequestIds: opened,
      };
    });
  }
  function selectProject(id: string) {
    setWorkspace((ws) => ({
      ...ws,
      selectedProjectId: id,
      selectedSessionId: null,
      selectedId:
        ws.drafts.find((d) => d.projectId === id && ws.openRequestIds.includes(d.id))?.id ??
        ws.drafts.find((d) => d.projectId === id)?.id ??
        "",
    }));
    navigate("repeater");
  }
  function createProject(name: string) {
    const created = { id: newId(), name };
    setWorkspace((ws) => ({
      ...ws,
      projects: [...ws.projects, created],
      selectedId: "",
      selectedProjectId: created.id,
      selectedSessionId: null,
    }));
    navigate("repeater");
  }
  function newSession(id: string) {
    const created: SessionDraft = {
      id: newId(),
      projectId: id,
      title: t.sessionDraft,
      instructions: "",
    };
    setWorkspace((ws) => ({
      ...ws,
      sessions: [...ws.sessions, created],
      selectedProjectId: id,
      selectedSessionId: created.id,
      selectedId:
        ws.drafts.find((d) => d.projectId === id && ws.openRequestIds.includes(d.id))?.id ??
        ws.drafts.find((d) => d.projectId === id)?.id ??
        "",
    }));
    navigate("session");
  }
  function selectSession(item: SessionDraft) {
    setWorkspace((ws) => ({
      ...ws,
      selectedProjectId: item.projectId,
      selectedSessionId: item.id,
      selectedId:
        ws.drafts.find((d) => d.projectId === item.projectId && ws.openRequestIds.includes(d.id))
          ?.id ??
        ws.drafts.find((d) => d.projectId === item.projectId)?.id ??
        "",
    }));
    navigate("session");
  }
  function patchSession(patch: Partial<SessionDraft>) {
    setWorkspace((ws) => ({
      ...ws,
      sessions: ws.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)),
    }));
  }
  function openEntry(item: Entry) {
    setOpenedEntry(item);
    setWorkspace((ws) => ({
      ...ws,
      drafts: ws.drafts.some((d) => d.id === item.draft.id)
        ? ws.drafts
        : [...ws.drafts, item.draft],
      selectedProjectId: item.draft.projectId,
      selectedId: item.draft.id,
      openRequestIds: ws.openRequestIds.includes(item.draft.id)
        ? ws.openRequestIds
        : [...ws.openRequestIds, item.draft.id],
    }));
    navigate("repeater");
  }
  async function run(target: Draft) {
    if (running.current) return;
    setOpenedEntry(null);
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setNotice(null);
    const snapshot = { ...target };
    try {
      const result = await send(
        {
          target: snapshot.target,
          raw: snapshot.raw,
          followRedirects: snapshot.followRedirects,
          timeoutSeconds: snapshot.timeoutSeconds,
        },
        controller.signal,
      );
      push({ id: newId(), draft: snapshot, at: new Date().toISOString(), result });
      toast.success(`${result.status} ${result.statusText || ""}`.trim());
    } catch (error) {
      const message = controller.signal.aborted
        ? "Request cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
      push({ id: newId(), draft: snapshot, at: new Date().toISOString(), error: message });
      toast.error(message);
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  function push(item: Entry) {
    setHistory((list) => [item, ...list].slice(0, MAX_ENTRIES));
    setNotice({ text: item.error ?? t.sendOk, ok: !item.error });
  }
  function collect() {
    if (!entry?.result) return;
    setContext((list) =>
      list.some((e) => e.id === entry.id)
        ? list
        : [...list, { ...entry, savedAt: new Date().toISOString() }],
    );
    toast.success(t.collect);
  }
  function download(data: string, name: string, type = "application/json") {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadCA() {
    try {
      download(await capture.certificate(), "acro-ca.pem", "application/x-pem-file");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
  function saveResponse() {
    if (entry?.result) download(entry.result.body, "acro-response.txt", "text/plain");
  }
  function exportContext() {
    download(
      JSON.stringify({ schemaVersion: 1, project, snapshots: projectContext }, null, 2),
      "acro-context.json",
    );
  }
  function exportSession() {
    if (session)
      download(
        JSON.stringify(
          { schemaVersion: 1, status: "draft", project, session, snapshots: projectContext },
          null,
          2,
        ),
        "acro-session.json",
      );
  }
  const renderSidebar = (iconOnly: boolean, onClose?: () => void) => (
    <WorkspaceSidebar
      projects={workspace.projects}
      sessions={workspace.sessions}
      projectId={projectId}
      sessionId={sessionId}
      view={view}
      counts={{
        capture: Math.max(traffic.length, Math.min(500, captureSettings.captured)),
        history: projectHistory.length,
        context: projectContext.length,
      }}
      onView={navigate}
      onProject={selectProject}
      onSession={selectSession}
      onCreateProject={createProject}
      onNewSession={newSession}
      iconOnly={iconOnly}
      onClose={onClose}
      t={t}
    />
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="acro-shell flex h-dvh flex-col bg-canvas text-ink"
        data-collapsed={narrow || !sidebar}
      >
        <header className="acro-titlebar flex h-9 shrink-0 items-center">
          <div
            className={cn(
              "flex h-full w-(--rail-width) shrink-0 items-center border-r border-hairline bg-rail",
              sidebar && !narrow ? "justify-between pl-[21px] pr-3" : "justify-center",
            )}
          >
            {sidebar && !narrow && <img className="acro-wordmark" src={wordmark} alt="Acro" />}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={sidebar && !narrow ? t.hideSidebar : t.showSidebar}
              title={sidebar && !narrow ? t.hideSidebar : t.showSidebar}
              onClick={() => setSidebar((v) => !v)}
            >
              {sidebar && !narrow ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </div>
          <div className="ml-auto flex h-full shrink-0 items-center gap-0.5 px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.commandPlaceholder}
              onClick={() => setPalette(true)}
            >
              <Search />
            </Button>
            <Select
              value={locale}
              onValueChange={(value) => setWorkspace((ws) => ({ ...ws, locale: value as Locale }))}
            >
              <SelectPrimitive.Trigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t.language}>
                  <Languages />
                </Button>
              </SelectPrimitive.Trigger>
              <SelectContent align="end" position="popper">
                <SelectGroup>
                  {locales.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t.theme}
              onClick={() =>
                setWorkspace((ws) => ({
                  ...ws,
                  appearance:
                    ws.appearance === "dark"
                      ? "light"
                      : ws.appearance === "light"
                        ? "system"
                        : "dark",
                }))
              }
            >
              {appearance === "dark" ? <Moon /> : appearance === "light" ? <Sun /> : <Monitor />}
            </Button>
            {view === "browser" && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t.credentials}
                title={t.credentials}
                aria-pressed={showVault}
                onClick={() => setShowVault((v) => !v)}
              >
                <PanelRight />
              </Button>
            )}
            {native && (
              <div className="ml-1 flex items-center gap-0.5 border-l border-hairline pl-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.minimizeWindow}
                  title={t.minimizeWindow}
                  onClick={() => void currentWindow.minimize()}
                >
                  <Minus />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.toggleMaximizeWindow}
                  title={t.toggleMaximizeWindow}
                  onClick={() => void currentWindow.toggleMaximize()}
                >
                  <Square />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.closeWindow}
                  title={t.closeWindow}
                  onClick={() => void currentWindow.close()}
                >
                  <X />
                </Button>
              </div>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="workspace-sidebar" aria-label={t.navigation}>
            {renderSidebar(narrow || !sidebar)}
          </aside>
          <Dialog open={narrow && sidebar} onOpenChange={setSidebar}>
            <DialogContent
              className="inset-y-0 left-0 top-0 flex h-dvh w-[min(18rem,90vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-sidebar p-0"
              showCloseButton={false}
              aria-describedby={undefined}
            >
              <DialogTitle className="sr-only">{t.navigation}</DialogTitle>
              {narrow && renderSidebar(false, () => setSidebar(false))}
            </DialogContent>
          </Dialog>
          <main className="flex min-w-0 flex-1 flex-col">
            {view === "repeater" ? (
              <RequestTabs
                drafts={openDrafts}
                selectedId={selectedId}
                onSelect={openRequest}
                onClose={closeRequest}
                onCapture={() => navigate("capture")}
                onFind={() => setPalette(true)}
                t={t}
              >
                {draft && (
                  <Repeater
                    key={draft.id}
                    draft={draft}
                    entry={entry}
                    busy={busy}
                    onChange={patchDraft}
                    onSend={() => void run(draft)}
                    onCancel={() => running.current?.abort()}
                    onDelete={deleteRequest}
                    onCollect={collect}
                    onSaveResponse={saveResponse}
                    t={t}
                  />
                )}
              </RequestTabs>
            ) : (
              <div
                className={
                  view === "browser"
                    ? "flex min-h-0 flex-1 flex-col overflow-hidden px-2 pt-3 pb-4 sm:px-4 lg:px-5"
                    : "flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-4 sm:px-4 lg:px-5"
                }
              >
                {/* The browser places a native WebView in this view's slot. It
                    must not sit in a scrolling ancestor, which would move the
                    slot under the pointer and clip the page. */}
                {view === "browser" && (
                  <BrowserView
                    projectId={projectId}
                    t={t}
                    showVault={showVault}
                    suspended={palette || (narrow && sidebar)}
                  />
                )}
                {view === "capture" && (
                  <CaptureView
                    traffic={traffic}
                    settings={captureSettings}
                    onSettings={setCaptureSettings}
                    filter=""
                    onReplay={replayCapture}
                    onClear={() =>
                      void capture
                        .clear()
                        .then(() => {
                          captureHistoryRequest.current = null;
                          captureHistoryLoaded.current = true;
                          setTraffic([]);
                          setCaptureSettings((s) => ({ ...s, captured: 0 }));
                        })
                        .catch((error) => toast.error(String(error)))
                    }
                    t={t}
                  />
                )}
                {view === "history" && (
                  <HistoryView
                    history={projectHistory}
                    onClear={() =>
                      setHistory((items) => items.filter((e) => e.draft.projectId !== projectId))
                    }
                    onOpen={openEntry}
                    t={t}
                  />
                )}
                {view === "context" && (
                  <ContextView
                    entries={projectContext}
                    onOpen={openEntry}
                    onExport={exportContext}
                    onRemove={(id) => setContext((items) => items.filter((e) => e.id !== id))}
                    t={t}
                  />
                )}
                {view === "session" && session && (
                  <SessionView
                    session={session}
                    projectName={
                      project?.id === "local" && project.name === "Local workspace"
                        ? t.localWorkspace
                        : (project?.name ?? t.workbench)
                    }
                    onChange={patchSession}
                    onExport={exportSession}
                    onEvidence={() => navigate("context")}
                    evidenceCount={projectContext.length}
                    t={t}
                  />
                )}
              </div>
            )}
          </main>
        </div>
        <footer className="flex h-[26px] shrink-0 items-center gap-2 border-t border-hairline px-3 text-micro text-ink-muted">
          <StatusDot
            tone={notice && !notice.ok ? "fail" : captureSettings.running ? "ok" : "muted"}
          />
          <span>{busy ? t.sending : captureSettings.running ? t.captureOn : t.ready}</span>
          {notice && (
            <span className={cn("min-w-0 truncate", !notice.ok && "text-fail")}>{notice.text}</span>
          )}
          <span className="ml-auto shrink-0 tabular-nums">
            {view === "capture"
              ? `${traffic.length} ${t.captureTraffic.toLowerCase()}`
              : `${drafts.length} ${drafts.length === 1 ? t.request.toLowerCase() : t.requestsCount}`}
          </span>
        </footer>
      </div>
      <CommandDialog
        open={palette}
        onOpenChange={setPalette}
        title={t.findRequest}
        description={t.commandPlaceholder}
      >
        <Command>
          <CommandInput placeholder={t.commandPlaceholder} />
          <CommandList>
            <CommandEmpty>{t.noMatch}</CommandEmpty>
            <CommandGroup heading={t.commandActions}>
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  navigate("capture");
                }}
              >
                {t.capture}
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  navigate("history");
                }}
              >
                <FolderClock />
                {t.history}
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  navigate("context");
                }}
              >
                <Layers />
                {t.context}
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  void downloadCA();
                }}
              >
                <ArrowDownToLine />
                {t.captureCertificate}
              </CommandItem>
              <CommandSeparator />
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  deleteRequest();
                }}
              >
                <Trash2 />
                {t.delete}
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setPalette(false);
                  exportContext();
                }}
              >
                <ArrowDownToLine />
                {t.export}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading={t.commandRequests}>
              {workspace.drafts.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.captureNumber ?? ""} ${item.id} ${item.name} ${item.target} ${item.raw.split("\n")[0]}`}
                  onSelect={() => {
                    setPalette(false);
                    openRequest(item.id);
                  }}
                >
                  <span
                    className={cn(
                      "proto w-10 shrink-0",
                      toneClass[outcomeOfMethod(requestLine(item.raw).method)],
                    )}
                  >
                    {requestLine(item.raw).method || "GET"}
                  </span>
                  <span className="truncate">{item.name}</span>
                  <span className="ml-auto truncate proto text-muted-foreground">
                    {originOf(item.target)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </TooltipProvider>
  );
}

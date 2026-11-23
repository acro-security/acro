import { useState, type ComponentType } from "react";
import {
  Globe,
  ChevronDown,
  Folder,
  History,
  Layers,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Radio,
  Repeat2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Dictionary } from "@/i18n";
import type { Project, SessionDraft } from "@/workspace";

export type WorkbenchView = "repeater" | "capture" | "history" | "context" | "session" | "browser";

export function WorkspaceSidebar({
  projects,
  sessions,
  projectId,
  sessionId,
  view,
  counts,
  onView,
  onProject,
  onSession,
  onCreateProject,
  onNewSession,
  onClose,
  iconOnly = false,
  t,
}: {
  projects: Project[];
  sessions: SessionDraft[];
  projectId: string;
  sessionId: string | null;
  view: WorkbenchView;
  counts: { capture: number; history: number; context: number };
  onView: (view: WorkbenchView) => void;
  onProject: (id: string) => void;
  onSession: (session: SessionDraft) => void;
  onCreateProject: (name: string) => void;
  onNewSession: (projectId: string) => void;
  onClose?: () => void;
  iconOnly?: boolean;
  t: Dictionary;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const features: { view: WorkbenchView; label: string; icon: ComponentType; count?: number }[] = [
    { view: "browser", label: t.browser, icon: Globe },
    { view: "repeater", label: t.repeater, icon: Repeat2 },
    { view: "capture", label: t.capture, icon: Radio, count: counts.capture },
    { view: "history", label: t.history, icon: History, count: counts.history },
    { view: "context", label: t.context, icon: Layers, count: counts.context },
  ];
  return (
    <>
      {onClose && (
        <div className="flex h-9 shrink-0 items-center justify-end px-3">
          <Button variant="ghost" size="icon-sm" aria-label={t.hideSidebar} onClick={onClose}>
            <PanelLeftClose />
          </Button>
        </div>
      )}
      <nav aria-label={t.workbench} className="workbench-nav flex shrink-0 flex-col px-2 py-2.5">
        {features.map(({ view: target, label, icon: Icon, count }) => (
          <Button
            key={target}
            variant="navigation"
            aria-label={label}
            title={label}
            aria-current={view === target ? "page" : undefined}
            onClick={() => onView(target)}
          >
            <Icon data-icon="inline-start" />
            {!iconOnly && <span>{label}</span>}
            {!iconOnly && !!count && (
              <span className="ml-auto text-micro tabular-nums text-muted-foreground">{count}</span>
            )}
          </Button>
        ))}
      </nav>
      {!iconOnly && (
        <>
          <div className="mt-7 flex h-9 shrink-0 items-center justify-between px-5">
            <h2 className="text-mini text-muted-foreground">{t.projects}</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t.newProject}
              onClick={() => {
                setName("");
                setCreating(true);
              }}
            >
              <Plus />
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1 px-3">
            <div className="flex flex-col gap-2 pb-6">
              {projects.map((project) => {
                const open = !collapsed.includes(project.id);
                const children = sessions.filter((s) => s.projectId === project.id);
                const label =
                  project.id === "local" && project.name === "Local workspace"
                    ? t.localWorkspace
                    : project.name;
                return (
                  <section key={project.id} aria-label={label}>
                    <div className="flex items-center">
                      <Button
                        variant="navigation"
                        aria-current={project.id === projectId ? "true" : undefined}
                        onClick={() => onProject(project.id)}
                        className="min-w-0 flex-1"
                      >
                        <Folder data-icon="inline-start" />
                        <span className="truncate">{label}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`${t.projects}: ${label}`}
                        aria-expanded={open}
                        onClick={() =>
                          setCollapsed((ids) =>
                            open ? [...ids, project.id] : ids.filter((id) => id !== project.id),
                          )
                        }
                      >
                        <ChevronDown className={cn(!open && "-rotate-90")} />
                      </Button>
                    </div>
                    {open && (
                      <div className="ml-4 flex flex-col gap-1 border-l border-sidebar-border pb-1 pl-3">
                        <div className="flex h-7 items-center justify-between pl-2">
                          <span className="text-micro text-muted-foreground">{t.sessions}</span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`${t.newSession}: ${label}`}
                            title={`${t.newSession}: ${label}`}
                            onClick={() => onNewSession(project.id)}
                          >
                            <Plus />
                          </Button>
                        </div>
                        {children.length ? (
                          children.map((session) => (
                            <Button
                              key={session.id}
                              variant="navigation"
                              aria-label={session.title.trim() || t.sessionDraft}
                              aria-current={
                                view === "session" && session.id === sessionId ? "page" : undefined
                              }
                              onClick={() => onSession(session)}
                              className="h-8 min-w-0"
                            >
                              <MessageSquare data-icon="inline-start" />
                              <span className="truncate">
                                {session.title.trim() || t.sessionDraft}
                              </span>
                            </Button>
                          ))
                        ) : (
                          <p className="px-2 pb-1 text-micro text-muted-foreground">
                            {t.noSessions}
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </ScrollArea>
        </>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.newProject}</DialogTitle>
            <DialogDescription>{t.projectHint}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) {
                onCreateProject(name.trim());
                setCreating(false);
              }
            }}
            className="flex flex-col gap-5"
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="project-name">{t.projectName}</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                  autoFocus
                />
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setCreating(false)}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {t.createProject}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

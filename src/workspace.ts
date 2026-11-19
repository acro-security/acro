import type { ReplayInput, ReplayResult } from "@/api";
import type { Locale } from "@/i18n";

export type Draft = ReplayInput & {
  id: string;
  name: string;
  projectId: string;
  captureNumber?: number;
};

export type Project = { id: string; name: string };
/** A local task draft; model execution is not connected yet. */
export type SessionDraft = { id: string; projectId: string; title: string; instructions: string };
export const LOCAL_PROJECT_ID = "local";

export type Entry = {
  id: string;
  draft: Draft;
  at: string;
  result?: ReplayResult;
  error?: string;
};

export type Appearance = "system" | "light" | "dark";

export type Workspace = {
  version: 3;
  drafts: Draft[];
  selectedId: string;
  locale: Locale;
  appearance: Appearance;
  projects: Project[];
  sessions: SessionDraft[];
  selectedProjectId: string;
  selectedSessionId: string | null;
  openRequestIds: string[];
};

export const MAX_ENTRIES = 100;

export function newId(): string {
  return crypto.randomUUID();
}

/** The method and path of a raw request's first line, blanks when absent. */
export function requestLine(raw: string): { method: string; path: string } {
  const [line = ""] = raw.split("\n");
  const [method = "", path = ""] = line.trim().split(/\s+/);
  return { method: method.toUpperCase(), path };
}

/**
 * The origin a request targets, as the source list groups them. Falls back to
 * the raw target so a malformed draft still has a home.
 */
export function originOf(target: string): string {
  try {
    return new URL(target).origin;
  } catch {
    return target || "No origin";
  }
}

export type Outcome = "ok" | "warn" | "fail" | "info" | "muted";

/** Status classes, so a row's color says what happened at a glance. */
export function outcomeOf(status?: number): Outcome {
  if (status === undefined) return "muted";
  if (status >= 500) return "fail";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "ok";
}

/** Methods colored by what they do to the target, not decoration. */
export function outcomeOfMethod(method: string): Outcome {
  switch (method) {
    case "POST":
      return "ok";
    case "PUT":
    case "PATCH":
      return "warn";
    case "DELETE":
      return "fail";
    case "HEAD":
    case "OPTIONS":
    case "TRACE":
      return "muted";
    case "":
      return "muted";
    default:
      return "info";
  }
}

export function byteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** The response as the chosen tab shows it. */
export function responseText(
  result: ReplayResult,
  tab: "body" | "headers" | "raw",
  pretty: boolean,
): string {
  const headers = result.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
  if (tab === "headers") return headers;
  if (tab === "raw") {
    return `${result.protocol} ${result.status} ${result.statusText}\n${headers}\n\n${result.body}`;
  }
  if (pretty && result.encoding !== "base64") {
    try {
      return JSON.stringify(JSON.parse(result.body), null, 2);
    } catch {
      /* not JSON: show it as received */
    }
  }
  return result.body;
}

const storageKey = "acro.workspace.v1";

export function freshWorkspace(): Workspace {
  return {
    version: 3,
    drafts: [],
    selectedId: "",
    locale: "en",
    appearance: "system",
    projects: [],
    sessions: [],
    selectedProjectId: "",
    selectedSessionId: null,
    openRequestIds: [],
  };
}

export function loadWorkspace(): Workspace | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!value || ![1, 2, 3].includes(value.version) || !Array.isArray(value.drafts)) return null;
    const raw: unknown[] = value.drafts;
    let drafts = raw.filter(
      (d): d is Draft =>
        !!d &&
        typeof (d as Draft).id === "string" &&
        typeof (d as Draft).name === "string" &&
        typeof (d as Draft).target === "string" &&
        typeof (d as Draft).raw === "string",
    );
    const projects: Project[] =
      value.version >= 2 && Array.isArray(value.projects)
        ? value.projects.filter(
            (p: Project) => p && typeof p.id === "string" && typeof p.name === "string",
          )
        : [];
    if (value.version === 1 && drafts.length && !projects.length)
      projects.push({ id: LOCAL_PROJECT_ID, name: "Local workspace" });
    const validProjects = new Set(projects.map((p) => p.id));
    drafts = drafts.map((d) => ({
      ...d,
      projectId:
        validProjects.has(d.projectId) || (value.version === 3 && d.projectId === "")
          ? d.projectId
          : (projects[0]?.id ?? ""),
      followRedirects: !!d.followRedirects,
      timeoutSeconds: Number.isFinite(d.timeoutSeconds) ? d.timeoutSeconds : 30,
    }));
    const selectedProjectId =
      validProjects.has(value.selectedProjectId) ||
      (value.version === 3 && value.selectedProjectId === "")
        ? value.selectedProjectId
        : (projects[0]?.id ?? "");
    const projectDrafts = drafts.filter((d) => d.projectId === selectedProjectId);
    const sessions: SessionDraft[] =
      value.version >= 2 && Array.isArray(value.sessions)
        ? value.sessions.filter(
            (s: SessionDraft) =>
              s &&
              typeof s.id === "string" &&
              validProjects.has(s.projectId) &&
              typeof s.title === "string" &&
              typeof s.instructions === "string",
          )
        : [];
    const draftIds = new Set(drafts.map((d) => d.id));
    return {
      version: 3,
      drafts,
      projects,
      sessions,
      selectedProjectId,
      selectedSessionId: sessions.some(
        (s) => s.id === value.selectedSessionId && s.projectId === selectedProjectId,
      )
        ? value.selectedSessionId
        : null,
      openRequestIds:
        value.version >= 2 && Array.isArray(value.openRequestIds)
          ? [
              ...new Set<string>(
                value.openRequestIds.filter(
                  (id: unknown): id is string => typeof id === "string" && draftIds.has(id),
                ),
              ),
            ]
          : drafts.map((d) => d.id),
      selectedId: projectDrafts.some((d) => d.id === value.selectedId)
        ? value.selectedId
        : (projectDrafts[0]?.id ?? ""),
      locale: value.locale === "zh-CN" || value.locale === "ja" ? value.locale : "en",
      appearance:
        value.appearance === "light" || value.appearance === "dark" ? value.appearance : "system",
    };
  } catch {
    return null;
  }
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(ws));
  } catch {
    /* storage full or blocked: the session still works */
  }
}

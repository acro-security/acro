import type { PrettyInput, PrettyOutput, PrettyPrepared } from "./pretty";
import { joinText } from "./pretty";
import { PreviewCache } from "./preview-cache";

/**
 * A preview is highlighted on demand. The worker prepares the text once and
 * ships the first slice; the view asks for the next slice when the reader
 * reaches the current end. Text nobody scrolls to is never coloured, which
 * matters because Shiki's cost grows faster than the text it sees.
 *
 * The worker sends the body's `<pre><code>` frame once and then only line spans,
 * so the view appends into one block instead of stacking one block per slice.
 */
export type PreviewProgress = PrettyOutput & {
  prepared: PrettyPrepared;
  /** Whether the whole body has arrived. */
  done: boolean;
  /** Ask for the next slice; a no-op once `done`. */
  more: () => void;
};

type Job = {
  key: string;
  prepared?: PrettyPrepared;
  headHtml: string;
  frame?: { open: string; close: string };
  body: string;
  done: boolean;
  rendering: boolean;
  error?: Error;
  listeners: Set<(progress: PreviewProgress) => void>;
};

let worker: Worker | undefined;
let nextId = 0;
const jobs = new Map<string, Job>();
const ids = new Map<number, Job>();
const cache = new PreviewCache();

function progressOf(job: Job): PreviewProgress | undefined {
  if (!job.prepared) return undefined;
  const body = job.frame ? job.frame.open + job.body + job.frame.close : job.body;
  const more = () => {
    if (job.done || job.rendering) return;
    const id = jobId(job);
    if (id === undefined) return;
    job.rendering = true;
    ensureWorker().postMessage({ id, kind: "render" });
  };
  return {
    text: joinText(job.prepared),
    html: job.headHtml + body,
    notice: job.error ? job.error.message : job.prepared.notice,
    prepared: job.prepared,
    done: job.done,
    more,
  };
}

const jobIds = new Map<Job, number>();
const jobId = (job: Job) => jobIds.get(job);

function emit(job: Job) {
  const progress = progressOf(job);
  if (progress) for (const listener of job.listeners) listener(progress);
}

type Message =
  | { id: number; kind: "prepared"; prepared: PrettyPrepared }
  | { id: number; kind: "head"; html: string }
  | { id: number; kind: "frame"; open: string; close: string }
  | { id: number; kind: "slice"; html: string; last: boolean }
  | { id: number; kind: "error"; error: string };

function handle(data: Message) {
  const job = ids.get(data.id);
  if (!job) return;
  if (data.kind === "error") {
    job.error = new Error(data.error);
    job.done = true;
    emit(job);
    ids.delete(data.id);
    return;
  }
  if (data.kind === "prepared") job.prepared = data.prepared;
  else if (data.kind === "head") job.headHtml = data.html;
  else if (data.kind === "frame") job.frame = { open: data.open, close: data.close };
  else if (data.kind === "slice") {
    // Each slice was rendered without the newline it was cut at, so the line
    // break between slices has to be put back here.
    job.body += (job.body ? "\n" : "") + data.html;
    job.rendering = false;
    if (data.last) job.done = true;
  }
  if (job.done) {
    const progress = progressOf(job);
    if (progress && !job.error)
      cache.store(job.key, {
        text: progress.text,
        html: progress.html,
        notice: progress.notice,
      });
    ids.delete(data.id);
  }
  emit(job);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./pretty.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<Message>) => handle(data);
  worker.onerror = () => {
    for (const job of [...jobs.values()]) {
      job.error = new Error("Code preview worker failed");
      job.done = true;
      emit(job);
    }
    jobs.clear();
    ids.clear();
    jobIds.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

/** A cached, fully highlighted preview needs no worker work at all. */
export const cachedPreview = (key: string): PrettyOutput | undefined => cache.get(key);

/**
 * Subscribe to a preview. The listener runs when the text is prepared, then as
 * the head and each slice arrive; call `progress.more()` to request another
 * slice. Returns an unsubscribe, which cancels the worker job once nobody is
 * listening — a closed pane should not keep colouring text.
 */
export function preview(
  key: string,
  input: PrettyInput,
  listener: (progress: PreviewProgress) => void,
): () => void {
  const running = jobs.get(key);
  if (running) {
    running.listeners.add(listener);
    const progress = progressOf(running);
    if (progress) listener(progress);
    return () => release(key, running, listener);
  }
  const id = ++nextId;
  const job: Job = {
    key,
    headHtml: "",
    body: "",
    done: false,
    rendering: false,
    listeners: new Set([listener]),
  };
  jobs.set(key, job);
  ids.set(id, job);
  jobIds.set(job, id);
  ensureWorker().postMessage({ id, kind: "prepare", input });
  return () => release(key, job, listener);
}

function release(key: string, job: Job, listener: (progress: PreviewProgress) => void) {
  job.listeners.delete(listener);
  if (job.listeners.size) return;
  const id = jobId(job);
  // Cancelling at once would restart the job whenever a view remounts, which
  // React's development strict mode does on every mount. A short grace period
  // lets the remount join the job that is already running.
  setTimeout(() => {
    if (job.listeners.size) return;
    jobs.delete(key);
    jobIds.delete(job);
    if (id === undefined) return;
    ids.delete(id);
    if (worker) worker.postMessage({ id, kind: "cancel" });
  }, 1000);
}

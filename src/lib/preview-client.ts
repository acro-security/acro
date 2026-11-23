import type { PrettyInput, PrettyPrepared } from "./pretty";
import type { PreviewReply, PreviewRequest } from "./pretty.worker";
import { PreviewCache } from "./preview-cache";

const prepared = new PreviewCache<PrettyPrepared>(24 * 1024 * 1024);
const highlighted = new PreviewCache(8 * 1024 * 1024, 96);
const pending = new Map<
  number,
  { resolve: (reply: PreviewReply) => void; reject: (error: Error) => void }
>();
let worker: Worker | undefined;
let nextId = 0;

function getWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL("./pretty.worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = ({ data }: MessageEvent<PreviewReply>) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.kind === "error") request?.reject(new Error(data.error));
    else request?.resolve(data);
  };
  instance.onerror = () => {
    instance.terminate();
    worker = undefined;
    for (const request of pending.values()) request.reject(new Error("Code preview worker failed"));
    pending.clear();
  };
  worker = instance;
  return instance;
}

function request(message: PreviewRequest): Promise<PreviewReply> {
  return new Promise((resolve, reject) => {
    const instance = getWorker();
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try {
      instance.postMessage({ ...message, id });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

export const cachedPreview = (key: string) => prepared.get(key);

export function loadPreview(key: string, input: PrettyInput) {
  return prepared.compute(key, async () => {
    const reply = await request({ kind: "prepare", input });
    if (reply.kind !== "prepared") throw new Error("Unexpected code preview response");
    return reply.value;
  });
}

type HighlightJob = { text: string; language: string; listeners: Set<(html: string) => void> };
const highlightQueue = new Map<string, HighlightJob>();
let runningHighlight: HighlightJob | undefined;

export function subscribeHighlight(
  text: string,
  language: string,
  receive: (html: string) => void,
) {
  const key = JSON.stringify([language, text]);
  const cached = highlighted.get(key);
  if (cached) {
    receive(cached.html);
    return;
  }
  const job = highlightQueue.get(key) ?? { text, language, listeners: new Set() };
  highlightQueue.set(key, job);
  job.listeners.add(receive);
  void renderNext();
  return () => {
    job.listeners.delete(receive);
    if (!job.listeners.size && job !== runningHighlight) highlightQueue.delete(key);
  };
}

async function renderNext() {
  if (runningHighlight) return;
  const entry = highlightQueue.entries().next().value;
  if (!entry) return;
  const [key, job] = entry;
  runningHighlight = job;
  try {
    const reply = await request({ kind: "highlight", text: job.text, language: job.language });
    if (reply.kind === "highlighted") {
      highlighted.store(key, { text: "", html: reply.value });
      for (const receive of job.listeners) receive(reply.value);
    }
  } catch {
    // The visible block remains readable as plain text.
  } finally {
    highlightQueue.delete(key);
    runningHighlight = undefined;
    void renderNext();
  }
}

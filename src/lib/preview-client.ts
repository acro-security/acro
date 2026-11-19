import type { PrettyInput, PrettyOutput } from "./pretty";
import { PreviewCache } from "./preview-cache";
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (out: PrettyOutput) => void; reject: (error: Error) => void }
>();
function computePreview(input: PrettyInput): Promise<PrettyOutput> {
  if (!worker) {
    worker = new Worker(new URL("./pretty.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) job?.reject(new Error(data.error));
      else job?.resolve(data.result);
    };
    worker.onerror = () => {
      for (const job of pending.values()) job.reject(new Error("Code preview worker failed"));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, input });
  });
}

const cache = new PreviewCache();
export const cachedPreview = (key: string) => cache.get(key);
export const preview = (key: string, input: PrettyInput) =>
  cache.compute(key, () => computePreview(input));

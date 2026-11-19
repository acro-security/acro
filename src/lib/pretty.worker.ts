import { prettify, type PrettyInput } from "./pretty";
self.onmessage = async ({ data }: MessageEvent<{ id: number; input: PrettyInput }>) => {
  try {
    self.postMessage({ id: data.id, result: await prettify(data.input) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};

import { highlight, prepare, type PrettyInput, type PrettyPrepared } from "./pretty";

export type PreviewRequest =
  { kind: "prepare"; input: PrettyInput } | { kind: "highlight"; text: string; language: string };

export type PreviewReply =
  | { id: number; kind: "prepared"; value: PrettyPrepared }
  | { id: number; kind: "highlighted"; value: string }
  | { id: number; kind: "error"; error: string };

self.onmessage = async ({ data }: MessageEvent<PreviewRequest & { id: number }>) => {
  const { id } = data;
  try {
    const reply: PreviewReply =
      data.kind === "prepare"
        ? { id, kind: "prepared", value: await prepare(data.input) }
        : { id, kind: "highlighted", value: await highlight(data.text, data.language) };
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({ id, kind: "error", error: String(error) } satisfies PreviewReply);
  }
};

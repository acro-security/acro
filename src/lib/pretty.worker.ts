import {
  prepare,
  renderBody,
  renderHead,
  splitFrame,
  type PrettyInput,
  type PrettyPrepared,
} from "./pretty";

/**
 * A body is highlighted on demand, one slice at a time. Shiki's cost grows
 * faster than the text it sees — a 127 KB bundle takes ~4.7 s in one call and
 * ~30 ms for its first screenful — so the worker prepares the text once, ships
 * the first slice, and then waits. The view asks for the next slice when the
 * reader reaches the current end, so text nobody scrolls to is never coloured.
 *
 * Slices end on line breaks, so a colour never depends on its neighbour. Each
 * `codeToHtml` call wraps its output in `<pre><code>`; the first slice ships
 * that frame once and later slices append only line spans, which is why the
 * view can paint one continuous block.
 */
const firstSlice = 8 * 1024;
const sliceSize = 16 * 1024;

type Prepared = { prepared: PrettyPrepared; at: number };

const sessions = new Map<number, Prepared>();

/** Cut at the last line break at or before `to`, never behind `from`. */
function sliceEnd(text: string, from: number, to: number): number {
  if (to >= text.length) return text.length;
  const cut = text.lastIndexOf("\n", to);
  return cut >= from ? cut + 1 : to;
}

type In =
  | { id: number; kind: "prepare"; input: PrettyInput }
  | { id: number; kind: "render" }
  | { id: number; kind: "cancel" };

self.onmessage = async ({ data }: MessageEvent<In>) => {
  if (data.kind === "cancel") {
    sessions.delete(data.id);
    return;
  }
  try {
    if (data.kind === "prepare") {
      const prepared = await prepare(data.input);
      sessions.set(data.id, { prepared, at: 0 });
      self.postMessage({ id: data.id, kind: "prepared", prepared });
      const head = await renderHead(prepared);
      if (head) self.postMessage({ id: data.id, kind: "head", html: head });
      // The first slice is shipped unasked: it is what makes the pane readable
      // without waiting for a scroll event.
      await render(data.id);
      return;
    }
    await render(data.id);
  } catch (error) {
    sessions.delete(data.id);
    self.postMessage({ id: data.id, kind: "error", error: String(error) });
  }
};

async function render(id: number) {
  const session = sessions.get(id);
  if (!session) return;
  const { prepared } = session;
  const from = session.at;
  if (from >= prepared.text.length) {
    sessions.delete(id);
    self.postMessage({ id, kind: "done" });
    return;
  }
  const to = sliceEnd(prepared.text, from, from + (from === 0 ? firstSlice : sliceSize));
  const end = to === prepared.text.length ? to : to - 1;
  const { open, lines, close } = splitFrame(await renderBody(prepared, from, end));
  if (from === 0) self.postMessage({ id, kind: "frame", open, close });
  session.at = to;
  const last = to >= prepared.text.length;
  if (last) sessions.delete(id);
  self.postMessage({ id, kind: "slice", html: lines, last });
}

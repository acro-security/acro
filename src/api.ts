import { isMyGo } from "mygo-runtime";
import { Replay, type Input, type Result } from "./mygo";

export type ReplayInput = Input;
export type ReplayResult = Result;

/** True when the page runs inside the app, where Go answers. */
export const native = isMyGo();

/**
 * Send replays one request. In the app this goes through mygo IPC to the Go
 * engine; in a browser it goes to the development server, which runs the very
 * same engine, so both transports share one behavior.
 */
export async function send(input: ReplayInput, signal: AbortSignal): Promise<ReplayResult> {
  if (native) return Replay.send.with({ signal })(input);

  let response: Response;
  try {
    response = await fetch("/api/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Development API unavailable. Run `just api` to start it.");
  }
  if (response.status >= 500) {
    throw new Error("Development API unavailable. Run `just api` to start it.");
  }
  // A refused or failed request answers in text, not JSON: read the body once
  // and report what the transport actually said instead of a parse error.
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : body.trim() || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!data) throw new Error("The development API returned an invalid response.");
  return data as ReplayResult;
}

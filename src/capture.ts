import { events, Capture, type Settings, type Traffic } from "./mygo";
import { native } from "./api";

export type { Settings, Traffic };

const base = "/api/capture";

/** Read one JSON endpoint of the development transport. */
async function dev<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, init);
  const data = await response.json();
  if (response.ok) return data as T;
  throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
}

/**
 * capture talks to Acro's intercepting proxy. In the app these calls go through
 * mygo IPC; in a browser they reach the development server, which runs the same
 * Go code, so both transports behave the same.
 */
export const capture = {
  status: (): Promise<Settings> =>
    native ? Promise.resolve(Capture.status()) : dev<Settings>("/status"),

  start: async (): Promise<Settings> => {
    if (!native) return dev<Settings>("/start", { method: "POST" });
    return await Capture.start();
  },

  stop: async (): Promise<Settings> => {
    if (!native) return dev<Settings>("/stop", { method: "POST" });
    return await Capture.stop();
  },

  clear: async (): Promise<void> => {
    if (!native) {
      await dev<Settings>("/clear", { method: "POST" });
      return;
    }
    await Capture.clear();
  },

  history: (): Promise<Traffic[]> =>
    native ? Promise.resolve(Capture.history()) : dev<Traffic[]>("/history"),

  /** The root certificate clients install to trust the proxy. */
  certificate: (): Promise<string> => {
    if (!native) {
      return fetch(base + "/ca").then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
    }
    return Capture.certificate();
  },

  /**
   * watch subscribes to the exchanges as the proxy records them. It returns a
   * function that ends the subscription.
   */
  watch: (onTraffic: (traffic: Traffic) => void, onState: (state: Settings) => void) => {
    if (native) {
      const offTraffic = events.traffic.on(onTraffic);
      const offState = events.captureState.on(onState);
      return () => {
        offTraffic();
        offState();
      };
    }
    const stream = new EventSource(base + "/stream");
    stream.addEventListener("traffic", (e) => onTraffic(JSON.parse(e.data)));
    stream.addEventListener("state", (e) => onState(JSON.parse(e.data)));
    return () => stream.close();
  },
};

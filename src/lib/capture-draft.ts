import type { Traffic } from "@/capture";
import type { Draft } from "@/workspace";

export function draftFromTraffic(item: Traffic, projectId: string): Draft {
  if (!item.requestHttp || item.method === "CONNECT")
    throw new Error("This capture has no replayable HTTP request");
  if (item.requestEncoding === "base64")
    throw new Error("Binary request bodies cannot be edited in Repeater yet");
  const text = item.requestHttp;
  const separator = /\r?\n\r?\n/.exec(text);
  const boundary = separator?.index ?? -1;
  const head = (boundary < 0 ? text : text.slice(0, boundary)).replace(/\r\n/g, "\n").split("\n");
  const body = boundary < 0 ? "" : text.slice(boundary + separator![0].length);
  const declaredLength = Number(
    head
      .find((h) => /^content-length:/i.test(h))
      ?.split(":")
      .slice(1)
      .join(":") ?? 0,
  );
  if (
    Math.max(item.requestSize, Number.isFinite(declaredLength) ? declaredLength : 0) >
    new TextEncoder().encode(body).length
  )
    throw new Error("The captured request body is incomplete and cannot be replayed");
  const url = new URL(item.url);
  const connection = head
    .filter((h) => /^connection:/i.test(h))
    .flatMap((h) =>
      h
        .slice(h.indexOf(":") + 1)
        .toLowerCase()
        .split(",")
        .map((v) => v.trim()),
    );
  const omitted = new Set([
    "transfer-encoding",
    "content-length",
    "proxy-connection",
    "proxy-authorization",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    ...connection,
  ]);
  const headers = head.slice(1).filter((h) => !omitted.has(h.split(":", 1)[0]!.toLowerCase()));
  return {
    id: item.id,
    captureNumber: item.sequence,
    projectId,
    name: `${item.method} ${url.pathname}`,
    target: url.origin,
    raw:
      [`${item.method} ${url.pathname}${url.search} HTTP/1.1`, ...headers].join("\n") +
      "\n\n" +
      body,
    followRedirects: false,
    timeoutSeconds: 30,
  };
}

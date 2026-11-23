import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { prettify, prepare, renderBody, splitFrame as frameOf } from "../src/lib/pretty";
import { draftFromTraffic } from "../src/lib/capture-draft";
import type { Traffic } from "../src/capture";

describe("Pretty preview", () => {
  test.each([
    ['{"a":1,"b":[true,false]}', "application/json", '  "a": 1'],
    ["<html><body><div>Hello</div></body></html>", "text/html", "\n"],
    ["const f=(x)=>{return {value:x+1}}", "application/javascript", "const f = (x) =>"],
    [
      'GET / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\r\n{"a":1}',
      "",
      '  "a": 1',
    ],
  ])("formats and highlights %s", async (text, mime, expected) => {
    const out = await prettify({ text, mime });
    expect(out.notice).toBeUndefined();
    expect(out.text).toContain(expected);
    expect(out.html).toContain('class="shiki');
    expect(out.html).toContain("<span style=");
  });
  test("decodes compressed text and escapes markup", async () => {
    const out = await prettify({
      text: gzipSync('<div onclick="alert(1)">Hello</div>').toString("base64"),
      mime: "text/html",
      encoding: "base64",
      compression: "gzip",
    });
    expect(out.text).toContain("Hello");
    expect(out.html).not.toContain("<div onclick=");
    expect(out.html).toContain("&#x3C;");
  });
  test("highlights a body in slices that add up to the single-pass result", async () => {
    const body = Array.from({ length: 900 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const prepared = await prepare({ text: body, mime: "application/javascript" });
    expect(prepared.language).toBe("javascript");
    const whole = frameOf(await renderBody(prepared, 0, prepared.text.length));
    // Mirror the worker: cut on newlines, render up to the cut newline, keep the
    // inner line spans, and rejoin with the newline the cut removed.
    const parts: string[] = [];
    let frame: { open: string; close: string } | undefined;
    let from = 0;
    while (from < prepared.text.length) {
      const at = prepared.text.indexOf("\n", from + 2000);
      const to = at < 0 ? prepared.text.length : at + 1;
      const end = to === prepared.text.length ? to : to - 1;
      const piece = frameOf(await renderBody(prepared, from, end));
      frame ??= { open: piece.open, close: piece.close };
      parts.push(piece.lines);
      from = to;
    }
    expect(parts.length).toBeGreaterThan(1);
    const joined = frame!.open + parts.join("\n") + frame!.close;
    expect(joined).toBe(whole.open + whole.lines + whole.close);
  });
  test("keeps the highlighted frame separate from the line spans", async () => {
    const prepared = await prepare({
      text: "HTTP/1.1 200 OK\nContent-Type: text/plain\n\nfirst\nsecond",
    });
    const html = await renderBody(prepared, 0, prepared.text.length);
    const at = html.indexOf("<code>");
    expect(at).toBeGreaterThan(0);
    // The slice appended later must be the inner lines only, so the frame's
    // open and close tags are exactly what sits outside them.
    expect(html.slice(0, at + 6)).toContain('<pre class="shiki');
    expect(html.endsWith("</code></pre>")).toBe(true);
    expect(html.slice(at + 6, -"</code></pre>".length)).toContain('<span class="line">');
  });
  test("formats a minified bundle larger than the preview limit before truncating it", async () => {
    // A real bundle is one enormous line: cutting it at the byte limit lands
    // inside a string, and Prettier then rejects the fragment. The preview must
    // format the whole body first and truncate the result at a line boundary.
    const body = `const config={items:[${Array.from(
      { length: 12000 },
      (_, i) => `{id:${i},label:"item ${i}"}`,
    ).join(",")}]};export default config;`;
    expect(body.length).toBeGreaterThan(128 * 1024);
    const out = await prettify({
      text: `HTTP/1.1 200 OK\nContent-Type: application/javascript\n\n${body}`,
    });
    expect(out.notice).toContain("128 KB");
    expect(out.notice).not.toContain("Formatting failed");
    expect(out.text).toContain("const config = {");
    expect(out.text.length).toBeLessThanOrEqual(128 * 1024 + 64);
    expect(out.html).toContain('class="shiki');
  });
  test("reports binary, malformed and oversized bodies without formatting them into messages", async () => {
    expect(
      (await prettify({ text: "AAEC", mime: "image/png", encoding: "base64" })).notice,
    ).toContain("Binary body");
    expect((await prettify({ text: "{bad", mime: "application/json" })).text).toBe("{bad");
    expect((await prettify({ text: "x".repeat(140000) })).notice).toContain("128 KB");
  });
});

test("captured replay retains source ID and body, normalizes HTTP framing", () => {
  const body = '{\r\n"value":1\r\n}';
  const item = {
    id: "capture-42",
    sequence: 42,
    method: "POST",
    url: "https://example.test/upload?q=1",
    requestHttp: `POST https://example.test/upload?q=1 HTTP/1.1\r\nHost: example.test\r\nTransfer-Encoding: chunked\r\nConnection: x-secret\r\nX-Secret: remove\r\nContent-Type: application/json\r\n\r\n${body}`,
    requestSize: body.length,
    requestEncoding: "utf-8",
  } as Traffic;
  const out = draftFromTraffic(item, "");
  expect(out.id).toBe("capture-42");
  expect(out.captureNumber).toBe(42);
  expect(out.raw).toBe(
    `POST /upload?q=1 HTTP/1.1\nHost: example.test\nContent-Type: application/json\n\n${body}`,
  );
  expect(() => draftFromTraffic({ ...item, requestSize: 100 }, "")).toThrow("incomplete");
  expect(() =>
    draftFromTraffic(
      {
        ...item,
        requestHttp: item.requestHttp.replace("Transfer-Encoding: chunked", "Content-Length: 100"),
      },
      "",
    ),
  ).toThrow("incomplete");
  expect(() => draftFromTraffic({ ...item, requestEncoding: "base64" }, "")).toThrow(
    "Binary request",
  );
});

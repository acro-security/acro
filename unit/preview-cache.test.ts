import { expect, test } from "bun:test";
import { PreviewCache, previewKey } from "../src/lib/preview-cache";
import { prettify } from "../src/lib/pretty";

test("reuses decoded gzip and highlighted output, including simultaneous consumers", async () => {
  const cache = new PreviewCache();
  const input = {
    text: "H4sIAAAAAAAAA+Lliq5WyivNVbIyMzHSUSoGsQzNTU1qY3m5AAAAAP//AwCP+BrUHAAAAA==",
    mime: "application/json",
    encoding: "base64",
    compression: "gzip",
  };
  const key = previewKey(input);
  let runs = 0;
  const create = () => {
    runs++;
    return prettify(input);
  };
  const first = cache.compute(key, create);
  expect(cache.compute(key, create)).toBe(first);
  const result = await first;
  expect(result.text).toContain('"num": 642');
  expect(cache.get(key)).toBe(result);
  expect(await cache.compute(key, create)).toBe(result);
  expect(runs).toBe(1);
  for (const change of [
    { text: "other" },
    { mime: "text/html" },
    { encoding: "utf-8" },
    { compression: "deflate" },
    { http: true },
  ])
    expect(previewKey({ ...input, ...change })).not.toBe(key);
});

test("evicts least recently used entries and enforces the byte budget", async () => {
  const cache = new PreviewCache(100, 2);
  const result = { text: "text", html: "html" };
  const put = (key: string) => cache.compute(key, async () => result);
  await put("a");
  await put("b");
  cache.get("a");
  await put("c");
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(result);
  await cache.compute("large", async () => ({ text: "x".repeat(100), html: "" }));
  expect(cache.get("large")).toBeUndefined();
  expect(cache.get("a")).toBe(result);
  const tiny = new PreviewCache(20);
  await tiny.compute("one", async () => ({ text: "abc", html: "" }));
  await tiny.compute("two", async () => ({ text: "abc", html: "" }));
  expect(tiny.get("one")).toBeUndefined();
  expect(tiny.get("two")).toBeDefined();
});

test("worker failures can be retried", async () => {
  const cache = new PreviewCache();
  await expect(
    cache.compute("key", async () => {
      throw new Error("Worker failed");
    }),
  ).rejects.toThrow("Worker failed");
  const result = { text: "recovered", html: "" };
  expect(await cache.compute("key", async () => result)).toBe(result);
});

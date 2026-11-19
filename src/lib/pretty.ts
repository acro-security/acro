import { format } from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as html from "prettier/plugins/html";
import * as postcss from "prettier/plugins/postcss";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type PrettyInput = {
  text: string;
  mime?: string;
  encoding?: string;
  compression?: string;
  http?: boolean;
};
export type PrettyOutput = { text: string; html: string; notice?: string };
const limit = 128 * 1024;
const highlighter = createHighlighterCore({
  themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
  langs: [
    import("shiki/langs/http.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/html.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/css.mjs"),
  ],
  engine: createJavaScriptRegexEngine(),
});

export function detectLanguage(text: string, mime = ""): string {
  if (/json/i.test(mime)) return "json";
  if (/html/i.test(mime) || /^\s*(?:<!doctype|<html|<[a-z][\w:-]*(?:\s|>))/i.test(text))
    return "html";
  if (/javascript|ecmascript/i.test(mime)) return "javascript";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    /* detect code below */
  }
  if (
    /^\s*(?:import\s|export\s|(?:const|let|var)\s|(?:async\s+)?function\s|\(?[\w, ]*\)?\s*=>)/.test(
      text,
    )
  )
    return "javascript";
  return "text";
}

async function decode(body: string, input: PrettyInput): Promise<string> {
  if (input.encoding !== "base64") return body;
  let bytes = Uint8Array.from(atob(body.trim()), (c) => c.charCodeAt(0));
  const compression = input.compression?.trim().toLowerCase();
  if (compression && compression !== "identity") {
    if (compression !== "gzip" && compression !== "deflate")
      throw new Error(`Preview does not support ${compression} compression`);
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream(compression))
      .getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error("Decoded preview exceeds 2 MB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
  }
  if (
    input.mime &&
    !/^(text\/|application\/(?:.*json|.*xml|javascript|ecmascript|x-www-form-urlencoded))/i.test(
      input.mime,
    )
  )
    throw new Error(`Binary body (${input.mime}) — view Raw for Base64 data`);
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\x00-\x08\x0e-\x1f]/.test(value)) throw new Error("Binary body — view Raw for Base64 data");
  return value;
}

export async function prettify(input: PrettyInput): Promise<PrettyOutput> {
  let source = input.text;
  let notice: string | undefined;
  const http = input.http || /^(?:[A-Z]+ \S+ HTTP\/\d|HTTP\/\d)/.test(source);
  let head = "";
  if (http) {
    const at = source.search(/\r?\n\r?\n/);
    if (at >= 0) {
      head = source.slice(0, at).replace(/\r\n/g, "\n");
      source = source.slice(at).replace(/^\r?\n\r?\n/, "");
    } else ((head = source), (source = ""));
  }
  const mime = input.mime ?? head.match(/^content-type:\s*(.+)$/im)?.[1] ?? "";
  const compression = input.compression ?? head.match(/^content-encoding:\s*(.+)$/im)?.[1];
  try {
    source = await decode(source, { ...input, mime, compression });
  } catch (error) {
    source = "";
    notice = error instanceof Error ? error.message : String(error);
  }
  if (source.length + head.length > limit) {
    source = source.slice(0, Math.max(0, limit - head.length));
    head = head.slice(0, limit);
    notice = "Pretty preview is limited to 128 KB — Raw contains the retained capture";
  }
  const language = detectLanguage(source, mime);
  if (source && language !== "text") {
    try {
      source =
        language === "json"
          ? JSON.stringify(JSON.parse(source), null, 2)
          : (
              await format(source, {
                parser: language === "javascript" ? "babel" : language,
                plugins: [babel, estree, html, postcss],
                tabWidth: 2,
              })
            ).trimEnd();
    } catch {
      notice = "Formatting failed — displaying the original content";
    }
  }
  const h = await highlighter;
  const render = (code: string, lang: string) =>
    h.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    });
  return {
    text: head ? `${head}\n\n${source}` : source,
    html: (head ? render(head, "http") : "") + (source ? render(source, language) : ""),
    notice,
  };
}

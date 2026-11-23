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
/**
 * The worker stages a preview: it formats and decodes first, then highlights in
 * slices so a large body paints its first screen long before the whole thing is
 * coloured. `text` is the formatted body; `head` is the HTTP status line and
 * headers, kept apart because they use the `http` grammar.
 */
export type PrettyPrepared = { head: string; text: string; language: string; notice?: string };
export type PrettyOutput = { text: string; html: string; notice?: string };
const themes = { light: "github-light", dark: "github-dark" } as const;
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
        if (size > 2 * 1024 * 1024) throw new Error("Decompressed body exceeds 2 MB");
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
  const prepared = await prepare(input);
  const html = (await renderHead(prepared)) + (await renderBody(prepared, 0, prepared.text.length));
  return { text: joinText(prepared), html, notice: prepared.notice };
}

export function joinText(prepared: PrettyPrepared): string {
  return prepared.head ? `${prepared.head}\n\n${prepared.text}` : prepared.text;
}

/** Decode and format, stopping before the expensive highlighting pass. */
export async function prepare(input: PrettyInput): Promise<PrettyPrepared> {
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
  return { head, text: source, language, notice };
}

export async function renderHead(prepared: PrettyPrepared): Promise<string> {
  if (!prepared.head) return "";
  return highlight(prepared.head, "http");
}

export async function renderBody(
  prepared: PrettyPrepared,
  from: number,
  to: number,
): Promise<string> {
  return highlight(prepared.text.slice(from, to), prepared.language);
}

export async function highlight(text: string, language: string): Promise<string> {
  if (!text) return "";
  const h = await highlighter;
  return h.codeToHtml(text, { lang: language, themes, defaultColor: "light" });
}

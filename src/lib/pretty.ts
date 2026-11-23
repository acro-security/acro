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
export type PrettySlice = { from: number; html: string };
export type PrettyOutput = { text: string; html: string; notice?: string };
const limit = 128 * 1024;
/**
 * Minified sources are one long line, so cutting them at a byte count almost
 * always lands inside a string or expression: Prettier then rejects the
 * fragment and the whole preview falls back to unformatted text. Formatting
 * first and truncating the formatted result at a line boundary keeps both the
 * parser and the reader happy. This cap bounds how much work that costs.
 */
const formatLimit = 1024 * 1024;
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
  if (head.length > limit) head = head.slice(0, limit);
  let cutBeforeFormat = false;
  if (source.length + head.length > limit) {
    notice = "Pretty preview is limited to 128 KB — Raw contains the retained capture";
    // The common case formats the whole body and truncates the result below, so
    // the cut never splits a token. A body past the formatting budget has to be
    // cut first; that fragment may no longer parse, so it is only highlighted.
    if (source.length > formatLimit) {
      source = source.slice(0, formatLimit);
      cutBeforeFormat = true;
      notice = "Pretty preview is limited to 1 MB — Raw contains the retained capture";
    }
  }
  const language = detectLanguage(source, mime);
  if (!cutBeforeFormat && source && language !== "text") {
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
  // Cut the formatted text, not the source: a line boundary keeps the preview
  // readable and highlights without inventing a syntax error.
  if (source.length > limit) {
    const cut = source.lastIndexOf("\n", limit);
    source = source.slice(0, cut > 0 ? cut : limit);
  }
  return { head, text: source, language, notice };
}

export async function renderHead(prepared: PrettyPrepared): Promise<string> {
  if (!prepared.head) return "";
  const h = await highlighter;
  return h.codeToHtml(prepared.head, { lang: "http", themes, defaultColor: "light" });
}

/**
 * Highlight one slice of the formatted body. Slices are cut at line breaks by
 * the caller so each is highlighted as whole lines; a highlight colour never
 * depends on a neighbouring slice, so the parts concatenate into the same HTML
 * one pass would produce.
 */
export async function renderBody(
  prepared: PrettyPrepared,
  from: number,
  to: number,
): Promise<string> {
  if (!prepared.text || to <= from) return "";
  const h = await highlighter;
  return h.codeToHtml(prepared.text.slice(from, to), {
    lang: prepared.language,
    themes,
    defaultColor: "light",
  });
}

/**
 * Split Shiki's classic output into its `<pre><code>` frame and the line spans
 * it wraps. A body is highlighted slice by slice, and only the first slice
 * needs the frame: later slices append lines into the same block.
 */
export function splitFrame(html: string): { open: string; lines: string; close: string } {
  const start = html.indexOf("<code>");
  const end = html.lastIndexOf("</code>");
  if (start < 0 || end < 0) return { open: "", lines: html, close: "" };
  return {
    open: html.slice(0, start + "<code>".length),
    lines: html.slice(start + "<code>".length, end),
    close: html.slice(end),
  };
}

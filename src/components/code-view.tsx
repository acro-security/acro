import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { PrettyInput, PrettyPrepared } from "@/lib/pretty";
import { cachedPreview, loadPreview, subscribeHighlight } from "@/lib/preview-client";
import { previewKey } from "@/lib/preview-cache";
import { markCode, normalizeCodeLines, type CodeMatch } from "@/lib/code-search";
import { cn } from "@/lib/utils";

type CodePreviewData = {
  key: string;
  prepared: PrettyPrepared;
  text: string;
};

export function CodeView({
  pretty = true,
  wrap,
  numbered,
  ...input
}: PrettyInput & { pretty?: boolean; wrap?: boolean; numbered?: boolean }) {
  const progress = useCodePreview(input, pretty);
  return <CodePreview text={input.text} progress={progress} wrap={wrap} numbered={numbered} />;
}

export function useCodePreview(
  { text, mime, encoding, compression, http }: PrettyInput,
  pretty: boolean,
) {
  const key = useMemo(
    () => previewKey({ text, mime, encoding, compression, http }),
    [text, mime, encoding, compression, http],
  );
  const [preview, setPreview] = useState<CodePreviewData>();

  useEffect(() => {
    if (!pretty) {
      setPreview(undefined);
      return;
    }

    let active = true;
    const receive = (prepared: PrettyPrepared) => {
      if (!active) return;
      const fullText = prepared.head ? `${prepared.head}\n\n${prepared.text}` : prepared.text;
      setPreview({ key, prepared, text: fullText });
    };
    const cached = cachedPreview(key);
    if (cached) receive(cached);
    else
      loadPreview(key, { text, mime, encoding, compression, http }).then(receive, (error: Error) =>
        receive({ head: "", text, language: "text", notice: error.message }),
      );
    return () => {
      active = false;
    };
  }, [key, text, mime, encoding, compression, http, pretty]);

  return pretty && preview?.key === key ? preview : undefined;
}

export function CodePreview({
  text,
  progress,
  wrap = true,
  matches,
  current,
  numbered = false,
}: {
  text: string;
  progress?: CodePreviewData;
  wrap?: boolean;
  matches?: CodeMatch[];
  current?: CodeMatch;
  numbered?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const needsDocument = numbered || text.length > chunkCharacters || !!matches?.length;
  const plainDocument = useMemo<PrettyPrepared | undefined>(
    () => (!progress && needsDocument ? { head: "", text, language: "text" } : undefined),
    [progress, text, needsDocument],
  );
  const prepared = progress?.prepared ?? plainDocument;
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-3" data-testid="code-view">
      {prepared ? (
        <CodeDocument
          key={progress?.key ?? "plain"}
          prepared={prepared}
          formatted={!!progress}
          scroller={scroller}
          wrap={wrap}
          matches={matches}
          current={current}
          numbered={numbered}
        />
      ) : (
        <pre className={cn("message-code", wrap && "whitespace-pre-wrap break-words")}>{text}</pre>
      )}
    </div>
  );
}

const chunkLines = 32;
const chunkCharacters = 8 * 1024;

type Chunk = {
  text: string;
  language: string;
  columns: number[];
  offset: number;
  firstLine: number;
};

function chunksFor(text: string, language: string, offset = 0, firstLine = 1): Chunk[] {
  const chunks: Chunk[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    const chunkText = batch.join("\n");
    chunks.push({
      text: chunkText,
      language: size > chunkCharacters ? "text" : language,
      offset,
      firstLine,
      // Geist Mono uses one cell per ASCII character. Wrapped chunks are
      // measured once rendered, including tabs and wider glyphs.
      columns: batch.map((line) => line.length),
    });
    offset += chunkText.length + 1;
    firstLine += batch.length;
    batch = [];
    size = 0;
  };
  for (const line of text.split("\n")) {
    if (batch.length && (batch.length === chunkLines || size + line.length > chunkCharacters))
      flush();
    batch.push(line);
    size += line.length + 1;
  }
  if (batch.length) flush();
  return chunks;
}

function CodeDocument({
  prepared,
  formatted,
  scroller,
  wrap,
  matches,
  current,
  numbered,
}: {
  prepared: PrettyPrepared;
  formatted: boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
  wrap: boolean;
  matches?: CodeMatch[];
  current?: CodeMatch;
  numbered: boolean;
}) {
  const documentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [width, setWidth] = useState(0);
  const chunks = useMemo(() => {
    const head = normalizeCodeLines(prepared.head);
    const body = normalizeCodeLines(prepared.text);
    const header = head ? chunksFor(head + (body ? "\n" : numbered ? "\n\n" : ""), "http") : [];
    const last = header.at(-1);
    return [
      ...header,
      ...(body || (numbered && !head)
        ? chunksFor(
            body,
            prepared.language,
            head ? head.length + 2 : 0,
            last ? last.firstLine + last.columns.length : 1,
          )
        : []),
    ];
  }, [prepared, numbered]);
  const longestLine = useMemo(
    () => chunks.reduce((longest, chunk) => Math.max(longest, ...chunk.columns), 0),
    [chunks],
  );
  const lastChunk = chunks.at(-1);
  const lineCount = lastChunk ? lastChunk.firstLine + lastChunk.columns.length - 1 : 1;
  const gutter = numbered ? codeGutterColumns(lineCount) : 0;

  useLayoutEffect(() => {
    const view = scroller.current;
    const document = documentRef.current;
    if (!view || !document) return;

    let intersection: IntersectionObserver;
    const observe = () => {
      const style = getComputedStyle(view);
      setWidth(view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      // Start highlighting both scroll directions two viewports ahead.
      const margin = Math.max(view.clientHeight * 2, 640);
      intersection?.disconnect();
      intersection = new IntersectionObserver(
        (entries) => {
          setActive((previous) => {
            const next = new Set(previous);
            for (const entry of entries) {
              const index = Number((entry.target as HTMLElement).dataset.codeChunk);
              if (entry.isIntersecting) next.add(index);
              else next.delete(index);
            }
            return next;
          });
        },
        { root: view, rootMargin: `${margin}px 0px` },
      );
      for (const chunk of document.children) intersection.observe(chunk);
    };
    observe();
    const resize = new ResizeObserver(observe);
    resize.observe(view);
    return () => {
      resize.disconnect();
      intersection.disconnect();
    };
  }, [chunks, scroller]);

  const pendingReveal = useRef(false);
  const targetIndex = current
    ? chunks.findIndex(
        ({ offset, text }) => current.from >= offset && current.from < offset + text.length,
      )
    : -1;

  useLayoutEffect(() => {
    pendingReveal.current = targetIndex >= 0;
  }, [current, targetIndex, chunks]);

  useLayoutEffect(() => {
    if (!pendingReveal.current) return;
    const view = scroller.current;
    const block = documentRef.current?.children[targetIndex];
    if (!view || !block) return;
    const mark = block.querySelector('[data-current="true"]');
    const bounds = (mark ?? block).getBoundingClientRect();
    const viewport = view.getBoundingClientRect();
    if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
      view.scrollTop += bounds.top - viewport.top - view.clientHeight / 3;
    }
    if (mark) {
      if (bounds.left < viewport.left || bounds.right > viewport.right) {
        view.scrollLeft += bounds.left - viewport.left - 12;
      }
      pendingReveal.current = false;
    }
  }, [current, targetIndex, active, chunks, scroller]);

  return (
    <>
      {prepared.notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {prepared.notice}
        </p>
      )}
      <div
        ref={documentRef}
        className={cn(
          "message-code code-document",
          formatted && "syntax-preview",
          wrap && "code-wrap",
          numbered && "code-numbered",
        )}
        style={
          {
            "--code-gutter": `${gutter}ch`,
            minWidth: wrap ? undefined : `${longestLine + gutter}ch`,
          } as CSSProperties
        }
      >
        {chunks.map((chunk, index) => (
          <CodeChunk
            key={index}
            chunk={chunk}
            index={index}
            active={active.has(index)}
            width={wrap && width ? Math.max(1, width - gutter * 7.25) : 0}
            numbered={numbered}
            matches={active.has(index) ? matches : undefined}
            current={index === targetIndex ? current : undefined}
          />
        ))}
      </div>
    </>
  );
}

const CodeChunk = memo(function CodeChunk({
  chunk,
  index,
  active,
  width,
  matches,
  current,
  numbered,
}: {
  chunk: Chunk;
  index: number;
  active: boolean;
  width: number;
  matches?: CodeMatch[];
  current?: CodeMatch;
  numbered: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string>();
  const measured = useRef<{ width: number; height: number } | undefined>(undefined);
  const columns = width ? Math.max(1, Math.floor(width / 7.25)) : Infinity;
  const estimatedHeight =
    20 * chunk.columns.reduce((rows, line) => rows + Math.max(1, Math.ceil(line / columns)), 0);
  // An empty block preserves the scroll position after its code nodes unmount.
  const height = measured.current?.width === width ? measured.current.height : estimatedHeight;

  useLayoutEffect(() => {
    const block = element.current;
    if (!block || !active) return;
    const measure = () => {
      measured.current = { width, height: block.getBoundingClientRect().height };
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(block);
    return () => resize.disconnect();
  }, [active, width]);

  useEffect(() => {
    if (!active || chunk.language === "text" || !chunk.text) {
      setHtml(undefined);
      return;
    }
    return subscribeHighlight(chunk.text, chunk.language, setHtml);
  }, [active, chunk]);

  const markup = useMemo(() => {
    if (!active) return;
    const source = numbered ? numberedCodeHtml(chunk, html) : html;
    return matches?.length ? markCode(source, chunk.text, chunk.offset, matches, current) : source;
  }, [active, chunk, html, matches, current, numbered]);

  return (
    <div
      ref={element}
      data-code-chunk={index}
      style={active ? { minHeight: chunk.columns.length * 20 } : { height }}
    >
      {active &&
        (markup ? (
          // Both Shiki and the plain renderer escape the source text.
          <div dangerouslySetInnerHTML={{ __html: markup }} />
        ) : (
          <pre>
            <code>{chunk.text}</code>
          </pre>
        ))}
    </div>
  );
});

export function codeGutterColumns(lineCount: number) {
  return Math.max(4, String(lineCount).length + 2);
}

function numberedCodeHtml(chunk: Chunk, html?: string) {
  let lineNumber = chunk.firstLine;
  const lineTag = () => `<span class="line" data-line-number="${lineNumber++}">`;
  if (html) return html.replaceAll('<span class="line">', lineTag);

  const escape = (line: string) =>
    line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const lines = chunk.text.split("\n").map((line) => lineTag() + escape(line) + "</span>");
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrettyInput, PrettyPrepared } from "@/lib/pretty";
import { cachedPreview, loadPreview, subscribeHighlight } from "@/lib/preview-client";
import { previewKey } from "@/lib/preview-cache";
import { cn } from "@/lib/utils";

type CodePreviewData = {
  key: string;
  prepared: PrettyPrepared;
  text: string;
};

export function CodeView({
  pretty = true,
  wrap,
  ...input
}: PrettyInput & { pretty?: boolean; wrap?: boolean }) {
  const progress = useCodePreview(input, pretty);
  return <CodePreview text={input.text} progress={progress} wrap={wrap} />;
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
}: {
  text: string;
  progress?: CodePreviewData;
  wrap?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const plainDocument = useMemo<PrettyPrepared | undefined>(
    () =>
      !progress && text.length > chunkCharacters ? { head: "", text, language: "text" } : undefined,
    [progress, text],
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
        />
      ) : (
        <pre className={cn("message-code", wrap && "whitespace-pre-wrap break-words")}>{text}</pre>
      )}
    </div>
  );
}

const chunkLines = 32;
const chunkCharacters = 8 * 1024;

type Chunk = { text: string; language: string; columns: number[] };

function chunksFor(text: string, language: string): Chunk[] {
  if (!text) return [];
  const chunks: Chunk[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    chunks.push({
      text: batch.join("\n"),
      language: size > chunkCharacters ? "text" : language,
      // Geist Mono uses one cell per ASCII character. Wrapped chunks are
      // measured once rendered, including tabs and wider glyphs.
      columns: batch.map((line) => line.length),
    });
    batch = [];
    size = 0;
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
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
}: {
  prepared: PrettyPrepared;
  formatted: boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
  wrap: boolean;
}) {
  const documentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ReadonlySet<number>>(() => new Set([0]));
  const [width, setWidth] = useState(0);
  const chunks = useMemo(
    () => [
      ...chunksFor(prepared.head && prepared.text ? prepared.head + "\n" : prepared.head, "http"),
      ...chunksFor(prepared.text, prepared.language),
    ],
    [prepared],
  );
  const longestLine = useMemo(
    () => chunks.reduce((longest, chunk) => Math.max(longest, ...chunk.columns), 0),
    [chunks],
  );

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
        )}
        style={wrap ? undefined : { minWidth: `${longestLine}ch` }}
      >
        {chunks.map((chunk, index) => (
          <CodeChunk
            key={index}
            chunk={chunk}
            index={index}
            active={active.has(index)}
            width={wrap ? width : 0}
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
}: {
  chunk: Chunk;
  index: number;
  active: boolean;
  width: number;
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

  return (
    <div
      ref={element}
      data-code-chunk={index}
      style={active ? { minHeight: chunk.columns.length * 20 } : { height }}
    >
      {active &&
        (html ? (
          // The worker returns Shiki's escaped markup.
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{chunk.text}</code>
          </pre>
        ))}
    </div>
  );
});

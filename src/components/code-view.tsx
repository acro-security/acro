import {
  memo,
  useCallback,
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
    () => (pretty ? previewKey({ text, mime, encoding, compression, http }) : undefined),
    [text, mime, encoding, compression, http, pretty],
  );
  const [preview, setPreview] = useState<CodePreviewData>();

  useEffect(() => {
    if (key === undefined) {
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
  }, [key, text, mime, encoding, compression, http]);

  return pretty && preview?.key === key ? preview : undefined;
}

export function CodePreview({
  text,
  progress,
  wrap = true,
  matches,
  current,
  numbered = false,
  preparing,
}: {
  text: string;
  progress?: CodePreviewData;
  wrap?: boolean;
  matches?: CodeMatch[];
  current?: CodeMatch;
  numbered?: boolean;
  preparing?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const needsDocument = numbered || text.length > chunkCharacters || !!matches?.length;
  const plainDocument = useMemo<PrettyPrepared | undefined>(
    () =>
      !progress && !preparing && needsDocument ? { head: "", text, language: "text" } : undefined,
    [progress, text, needsDocument, preparing],
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
      ) : preparing ? (
        <p role="status" className="text-mini text-ink-muted">
          {preparing}
        </p>
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
  let chunkStart = 0;
  let columns: number[] = [];
  const flush = (end: number) => {
    chunks.push({
      text: text.slice(chunkStart, end),
      language: end - chunkStart >= chunkCharacters ? "text" : language,
      offset: offset + chunkStart,
      firstLine,
      columns,
    });
    firstLine += columns.length;
    columns = [];
  };
  let lineStart = 0;
  while (true) {
    const newline = text.indexOf("\n", lineStart);
    const end = newline < 0 ? text.length : newline;
    if (columns.length && (columns.length === chunkLines || end - chunkStart > chunkCharacters)) {
      flush(lineStart - 1);
      chunkStart = lineStart;
    }
    columns.push(end - lineStart);
    if (newline < 0) {
      flush(end);
      break;
    }
    lineStart = end + 1;
  }
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
  const [viewport, setViewport] = useState({ width: 0, height: 360, top: 0 });
  const [measurementVersion, setMeasurementVersion] = useState(0);
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

  const columns =
    wrap && viewport.width ? Math.max(1, Math.floor(viewport.width / 7.25 - gutter)) : Infinity;
  const estimates = useMemo(
    () =>
      chunks.map(({ columns: lengths }) =>
        columns === Infinity
          ? lengths.length * 20
          : lengths.reduce((rows, length) => rows + Math.max(1, Math.ceil(length / columns)), 0) *
            20,
      ),
    [chunks, columns],
  );
  const measurements = useMemo(() => new Map<number, number>(), [chunks, wrap, viewport.width]);
  const measureChunk = useCallback(
    (index: number, height: number) => {
      if (height <= 0 || (measurements.get(index) ?? estimates[index]) === height) return;
      measurements.set(index, height);
      setMeasurementVersion((version) => version + 1);
    },
    [estimates, measurements],
  );

  const offsets = useMemo(() => {
    const positions = [0];
    let y = 0;
    estimates.forEach((height, index) => {
      y += measurements.get(index) ?? height;
      positions.push(y);
    });
    return positions;
  }, [estimates, measurements, measurementVersion]);
  const margin = Math.max(viewport.height * 2, 640);
  const start = Math.min(chunks.length, chunkAt(offsets, viewport.top - margin));
  const end = Math.min(
    chunks.length,
    chunkAt(offsets, viewport.top + viewport.height + margin) + 1,
  );

  const updateViewport = useCallback(() => {
    const view = scroller.current;
    const document = documentRef.current;
    if (!view || !document) return;
    const style = getComputedStyle(view);
    const next = {
      width: view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: view.clientHeight,
      top: view.getBoundingClientRect().top - document.getBoundingClientRect().top,
    };
    setViewport((previous) =>
      previous.width === next.width && previous.height === next.height && previous.top === next.top
        ? previous
        : next,
    );
  }, [scroller]);

  useLayoutEffect(() => {
    const view = scroller.current;
    const document = documentRef.current;
    if (!view || !document) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateViewport();
      });
    };
    updateViewport();
    view.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(view);
    resize.observe(document);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      view.removeEventListener("scroll", schedule);
    };
  }, [scroller, updateViewport]);

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
    const document = documentRef.current;
    if (!view || !document) return;
    const block = document.querySelector(`[data-code-chunk="${targetIndex}"]`);
    if (!block) {
      view.scrollTop +=
        document.getBoundingClientRect().top -
        view.getBoundingClientRect().top +
        offsets[targetIndex]! -
        view.clientHeight / 3;
      updateViewport();
      return;
    }
    const mark = block.querySelector('[data-current="true"]');
    if (!mark) return;
    const bounds = mark.getBoundingClientRect();
    const visible = view.getBoundingClientRect();
    if (bounds.top < visible.top || bounds.bottom > visible.bottom) {
      view.scrollTop += bounds.top - visible.top - view.clientHeight / 3;
    }
    if (bounds.left < visible.left || bounds.right > visible.right) {
      view.scrollLeft += bounds.left - visible.left - 12;
    }
    pendingReveal.current = false;
  }, [current, targetIndex, offsets, start, end, scroller, updateViewport]);

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
        <div aria-hidden="true" style={{ height: offsets[start] }} />
        {chunks.slice(start, end).map((chunk, offset) => {
          const index = start + offset;
          return (
            <CodeChunk
              key={index}
              chunk={chunk}
              index={index}
              measure={measureChunk}
              numbered={numbered}
              matches={matches}
              current={index === targetIndex ? current : undefined}
            />
          );
        })}
        <div aria-hidden="true" style={{ height: offsets[chunks.length]! - offsets[end]! }} />
      </div>
    </>
  );
}

// Locate the first chunk whose bottom is beyond the given scroll offset.
function chunkAt(offsets: number[], top: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! <= top) low = middle + 1;
    else high = middle;
  }
  return low;
}

const CodeChunk = memo(function CodeChunk({
  chunk,
  index,
  measure,
  matches,
  current,
  numbered,
}: {
  chunk: Chunk;
  index: number;
  measure: (index: number, height: number) => void;
  matches?: CodeMatch[];
  current?: CodeMatch;
  numbered: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string>();

  useLayoutEffect(() => {
    const block = element.current;
    if (!block) return;
    const resize = new ResizeObserver(() => measure(index, block.getBoundingClientRect().height));
    resize.observe(block);
    return () => resize.disconnect();
  }, [index, measure]);

  useEffect(() => {
    if (chunk.language === "text" || !chunk.text) {
      setHtml(undefined);
      return;
    }
    return subscribeHighlight(chunk.text, chunk.language, setHtml);
  }, [chunk]);

  const markup = useMemo(() => {
    const source = numbered ? numberedCodeHtml(chunk, html) : html;
    return matches?.length ? markCode(source, chunk.text, chunk.offset, matches, current) : source;
  }, [chunk, html, matches, current, numbered]);

  return (
    <div ref={element} data-code-chunk={index} style={{ minHeight: chunk.columns.length * 20 }}>
      {markup ? (
        // Both Shiki and the plain renderer escape the source text.
        <div dangerouslySetInnerHTML={{ __html: markup }} />
      ) : (
        <pre>
          <code>{chunk.text}</code>
        </pre>
      )}
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

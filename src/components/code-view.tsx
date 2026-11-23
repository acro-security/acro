import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PrettyInput } from "@/lib/pretty";
import { cachedPreview, preview, type PreviewProgress } from "@/lib/preview-client";
import { previewKey } from "@/lib/preview-cache";
import { cn } from "@/lib/utils";

/**
 * CodeView paints a preview as it arrives: formatted text first, then the
 * highlighted head and body. The body arrives one slice at a time and the next
 * slice is requested when the reader nears the end, so a large response costs
 * only what has actually been looked at.
 */
export function CodeView({
  text,
  mime,
  encoding,
  compression,
  http,
  pretty = true,
  wrap = true,
}: PrettyInput & { pretty?: boolean; wrap?: boolean }) {
  const key = useMemo(
    () => previewKey({ text, mime, encoding, compression, http }),
    [text, mime, encoding, compression, http],
  );
  const [progress, setProgress] = useState<PreviewProgress | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef<PreviewProgress | null>(null);

  useEffect(() => {
    latest.current = null;
    if (!pretty) {
      setProgress(null);
      return;
    }
    const cached = cachedPreview(key);
    if (cached) {
      const full: PreviewProgress = {
        ...cached,
        prepared: { head: "", text: cached.text, language: "text" },
        done: true,
        more: () => {},
      };
      latest.current = full;
      setProgress(full);
      return;
    }
    let disposed = false;
    const stop = preview(key, { text, mime, encoding, compression, http }, (next) => {
      if (disposed) return;
      latest.current = next;
      setProgress(next);
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [key, text, mime, encoding, compression, http, pretty]);

  // Ask for the next slice before the reader hits the bottom, so scrolling does
  // not stall waiting for the worker.
  const requestMore = useCallback(() => {
    const view = scroller.current;
    const next = latest.current;
    if (!view || !next || next.done) return;
    const remaining = view.scrollHeight - view.scrollTop - view.clientHeight;
    if (remaining < view.clientHeight) next.more();
  }, []);

  useEffect(() => {
    requestMore();
  }, [progress, requestMore]);

  const ready = pretty ? progress : null;

  return (
    <div
      ref={scroller}
      onScroll={requestMore}
      className="min-h-0 flex-1 overflow-auto p-3"
      data-testid="code-view"
    >
      {ready?.notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {ready.notice}
        </p>
      )}
      {ready?.html ? (
        <div
          className={cn("message-code syntax-preview", wrap && "code-wrap")}
          // The worker returns Shiki's escaped markup; nothing else enters here.
          dangerouslySetInnerHTML={{ __html: ready.html }}
        />
      ) : (
        <pre className={cn("message-code", wrap && "whitespace-pre-wrap break-words")}>
          {ready?.text ?? text}
        </pre>
      )}
    </div>
  );
}

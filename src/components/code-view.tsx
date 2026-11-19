import { useEffect, useMemo, useState } from "react";
import type { PrettyInput, PrettyOutput } from "@/lib/pretty";
import { cachedPreview, preview } from "@/lib/preview-client";
import { previewKey } from "@/lib/preview-cache";
import { cn } from "@/lib/utils";
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
  const [output, setOutput] = useState<(PrettyOutput & { key: string }) | null>(null);
  useEffect(() => {
    let disposed = false;
    if (pretty)
      void preview(key, { text, mime, encoding, compression, http })
        .then((out) => {
          if (!disposed) setOutput({ ...out, key });
        })
        .catch((error) => {
          if (!disposed) setOutput({ text, html: "", notice: String(error), key });
        });
    return () => {
      disposed = true;
    };
  }, [key, text, mime, encoding, compression, http, pretty]);
  const ready = pretty ? (cachedPreview(key) ?? (output?.key === key ? output : null)) : null;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {ready?.notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {ready.notice}
        </p>
      )}
      {ready?.html ? (
        <div
          className={cn("message-code syntax-preview", wrap && "code-wrap")}
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

import { useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { codeGutterColumns } from "@/components/code-view";
import { Textarea } from "@/components/ui/textarea";
import { normalizeCodeLines } from "@/lib/code-search";

export function CodeEditor({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => normalizeCodeLines(value).split("\n"), [value]);
  const syncGutter = useCallback(() => {
    const input = editor.current;
    if (!input || !gutter.current || !mirror.current) return;
    mirror.current.style.width = `${input.clientWidth}px`;
    gutter.current.scrollTop = input.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const input = editor.current;
    if (!input) return;
    const resize = new ResizeObserver(syncGutter);
    resize.observe(input);
    return () => resize.disconnect();
  }, [syncGutter]);

  useLayoutEffect(syncGutter, [syncGutter, value]);

  return (
    <div
      className="relative flex min-h-0 flex-1"
      style={{ "--code-gutter": `${codeGutterColumns(lines.length)}ch` } as CSSProperties}
    >
      <div
        ref={gutter}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      >
        <div
          ref={mirror}
          className="message-code code-document code-numbered code-wrap p-3 text-transparent"
        >
          <pre>
            <code>
              {lines.map((line, index) => (
                <span key={index} className="line" data-line-number={index + 1}>
                  {line}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
      <Textarea
        ref={editor}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncGutter}
        spellCheck={false}
        aria-label={label}
        className="message-code code-editor relative min-h-0 flex-1 resize-none field-sizing-fixed rounded-none border-0 bg-transparent p-3 text-ink shadow-none dark:bg-transparent"
      />
    </div>
  );
}

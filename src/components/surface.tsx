import type { ReactNode } from "react";
import type { Outcome } from "@/workspace";
import { cn } from "@/lib/utils";

/**
 * Panel is the one surface of the workbench: a bordered box that holds a
 * header strip and its scrollable body. Keeping a single radius and hairline
 * across panes is what makes nested content read as one instrument.
 */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
      <h2 className="text-mini font-medium text-ink">{title}</h2>
      {meta ? <div className="min-w-0 flex-1 truncate">{meta}</div> : <div className="flex-1" />}
      {children ? <div className="flex shrink-0 items-center gap-0.5">{children}</div> : null}
    </header>
  );
}

/**
 * SectionLabel names a group of rows. It is centered, small and quiet, as in a
 * sidebar that must not compete with the rows it groups.
 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-center text-micro font-medium tracking-wide text-ink-faint">
      {children}
    </div>
  );
}

/** StatusDot carries an outcome's color and nothing else. */
export function StatusDot({ tone, className }: { tone: Outcome; className?: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", dotClass[tone], className)} />;
}

export const toneClass: Record<Outcome, string> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  info: "text-intercept",
  muted: "text-ink-faint",
};

export const dotClass: Record<Outcome, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  fail: "bg-fail",
  info: "bg-intercept",
  muted: "bg-ink-faint",
};

// The pipeline board's card and column — ONE definition (cleanup task 3,
// retroactively resolving the U-2 contradiction that forced /opportunities to
// mirror /bid-board's markup by hand).
//
// Deliberately presentational: neither FpOpportunity nor PipelineItem appears
// here. Each view maps its own domain object into the slots below, so the
// shared piece owns exactly the thing that forked (the markup) and neither
// call site grows a union type it does not want. Interactivity (edit/delete
// buttons, links) is passed IN through slots, never defined here.
//
// tests/bid-board-view.test.ts asserts function identity across both views'
// re-exports — a copied version fails immediately, same guard as
// lib/deadline.ts. Do not copy this markup back into a view.

import Link from "next/link";
import type { DragEvent, ReactNode } from "react";

export type PipelineCardProps = {
  title: string;
  /** Second line: agency, sol number, whatever the view knows. */
  subtitle: ReactNode;
  /** Optional top-right element (the Bid Board's price). */
  right?: ReactNode;
  /** Rendered deadline text + its tone class (from lib/deadline.ts). */
  deadlineLabel: string;
  deadlineClass: string;
  /** Bottom-right chips: status label, source badge, etc. */
  badges: ReactNode;
  /** Optional footer row (the Bid Board's Edit/Delete buttons). */
  footer?: ReactNode;
  /** When set, the whole card is a link (the unified view). */
  href?: string;
  /**
   * Drag-and-drop slots (Bid Board kanban, 2026-08-13). Handlers are passed
   * IN like all interactivity here; a view that omits them (the unified
   * /opportunities view) renders exactly as before. Ignored on href cards —
   * a link-card can't also be a drag handle without fighting the browser.
   */
  draggable?: boolean;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void;
};

export function PipelineCard({
  title,
  subtitle,
  right,
  deadlineLabel,
  deadlineClass,
  badges,
  footer,
  href,
  draggable,
  onDragStart,
  onDragEnd,
}: PipelineCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="line-clamp-2 text-[13px] font-medium leading-snug text-stone-900" title={title}>
            {title}
          </div>
          <div className="mt-0.5 truncate text-xs text-stone-500">{subtitle}</div>
        </div>
        {right}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className={deadlineClass}>{deadlineLabel}</span>
        {badges}
      </div>
      {footer}
    </>
  );
  return href ? (
    <Link href={href} className="gs-card gs-card-interactive block p-3">
      {body}
    </Link>
  ) : (
    <div
      className={`gs-card gs-card-interactive p-3${draggable ? " cursor-grab active:cursor-grabbing" : ""}`}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {body}
    </div>
  );
}

export function PipelineColumn({
  label,
  count,
  children,
  onDragOver,
  onDragLeave,
  onDrop,
  dropActive,
}: {
  label: string;
  count: number;
  children: ReactNode;
  /** Drop-target slots (Bid Board kanban). All optional; omit for a static column. */
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
  /** True while a card is dragged over this column — the caller owns the state. */
  dropActive?: boolean;
}) {
  return (
    <div
      className={`flex min-h-24 flex-col rounded-lg border p-2 ${
        dropActive ? "border-emerald-400 bg-emerald-50/70" : "border-stone-200 bg-stone-50/60"
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-baseline justify-between px-1 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</span>
        <span className="text-xs tabular-nums text-stone-400">{count}</span>
      </div>
      <div className="flex flex-col gap-2">
        {children}
        {count === 0 && (
          <div className="rounded border border-dashed border-stone-200 px-2 py-3 text-center text-xs text-stone-400">
            empty
          </div>
        )}
      </div>
    </div>
  );
}

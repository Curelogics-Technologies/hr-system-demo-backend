/**
 * Drawing primitives for the KPI-style report layout.
 *
 * The report is bounded on two axes:
 *  - MAX_PAGES caps the document; sections stop rendering once it is reached.
 *  - maxRowsPerSection caps every detail table, which then prints a
 *    "showing N of M" line pointing back into the platform.
 *
 * Together these make report length roughly constant as the number of stores
 * and employees grows, which is the whole point of the redesign.
 */

import { PDFDocument, PDFFont, PDFPage, RGB, rgb } from 'pdf-lib';
import { RagStatus } from './reports-thresholds';

/**
 * Palette carried over from the original report design - the slate/gold identity
 * the client already approved - with a teal for section rules and RAG statuses
 * layered on top. Every pair below clears WCAG AA against its own background, and
 * RAG is never the only signal: each status also gets a coloured rail, so the
 * report survives greyscale printing and colour-blind readers.
 */
export const PALETTE = {
  ink: rgb(0.05, 0.13, 0.22),        // #0D2137 slate - headings, cover band
  teal: rgb(0.11, 0.45, 0.62),       // #1C739E - section rules
  accent: rgb(0.79, 0.59, 0.23),     // #C9973A gold - KPI emphasis, overflow notes
  body: rgb(0.22, 0.25, 0.29),
  muted: rgb(0.48, 0.52, 0.56),
  hairline: rgb(0.84, 0.86, 0.88),
  surface: rgb(0.968, 0.973, 0.978),
  surfaceAlt: rgb(0.99, 0.985, 0.97), // warm tint for KPI cards
  white: rgb(1, 1, 1),
  green: rgb(0.08, 0.5, 0.24),       // #14803D
  amber: rgb(0.71, 0.33, 0.04),      // #B5540A
  red: rgb(0.79, 0.11, 0.11),        // #C91C1C
};

export const RAG_COLOR: Record<RagStatus, RGB> = {
  green: PALETTE.green,
  amber: PALETTE.amber,
  red: PALETTE.red,
};

const MARGIN = 50;
const BOTTOM_GUTTER = 56;

export interface DocContext {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  width: number;
  height: number;
  y: number;
  pageCount: number;
  maxPages: number;
  /** Set once maxPages is hit; every draw helper becomes a no-op. */
  truncated: boolean;
  title: string;
  companyName: string;
}

export async function createDocContext(
  doc: PDFDocument,
  fonts: { font: PDFFont; fontBold: PDFFont; fontItalic: PDFFont },
  opts: { maxPages: number; title: string; companyName: string },
): Promise<DocContext> {
  const page = doc.addPage();
  const { width, height } = page.getSize();
  return {
    doc,
    page,
    ...fonts,
    width,
    height,
    y: height - MARGIN,
    pageCount: 1,
    maxPages: Math.max(1, opts.maxPages),
    truncated: false,
    title: opts.title,
    companyName: opts.companyName,
  };
}

/** Truncates text to fit `maxWidth`, appending an ellipsis when it overflows. */
export function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && font.widthOfTextAtSize(`${clipped}...`, size) > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

/**
 * Ensures `needed` vertical space exists, adding a page if not.
 * Returns false when the page budget is exhausted — callers must bail out.
 */
export function ensureSpace(ctx: DocContext, needed: number): boolean {
  if (ctx.truncated) return false;
  if (ctx.y - needed >= BOTTOM_GUTTER) return true;

  if (ctx.pageCount >= ctx.maxPages) {
    ctx.truncated = true;
    return false;
  }

  ctx.page = ctx.doc.addPage();
  const size = ctx.page.getSize();
  ctx.width = size.width;
  ctx.height = size.height;
  ctx.y = ctx.height - MARGIN;
  ctx.pageCount += 1;

  ctx.page.drawText(`${ctx.companyName} - ${ctx.title} (cont.)`, {
    x: MARGIN, y: ctx.height - 30, size: 8, font: ctx.fontItalic, color: PALETTE.muted,
  });
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.height - 35 },
    end: { x: ctx.width - MARGIN, y: ctx.height - 35 },
    thickness: 0.5, color: PALETTE.hairline,
  });
  return true;
}

/** Cover band. Red for alerts, slate otherwise, with a gold rule beneath. */
export function drawCoverHeader(
  ctx: DocContext,
  opts: {
    title: string; companyName: string; scopeLabel: string;
    /** Omitted when the report performs no period comparison. */
    periodLabel: string; comparisonLabel?: string; alert?: boolean;
  },
): void {
  const bandHeight = 100;
  ctx.page.drawRectangle({
    x: MARGIN, y: ctx.y - bandHeight, width: ctx.width - MARGIN * 2, height: bandHeight,
    color: opts.alert ? PALETTE.red : PALETTE.ink,
  });
  // Gold underline ties the cover to the section rules.
  ctx.page.drawRectangle({
    x: MARGIN, y: ctx.y - bandHeight - 3, width: ctx.width - MARGIN * 2, height: 3,
    color: PALETTE.accent,
  });

  ctx.page.drawText(opts.title.toUpperCase(), {
    x: MARGIN + 20, y: ctx.y - 32, size: 16, font: ctx.fontBold, color: PALETTE.white,
  });
  ctx.page.drawText(opts.companyName, {
    x: MARGIN + 20, y: ctx.y - 52, size: 10, font: ctx.fontBold, color: rgb(0.92, 0.92, 0.92),
  });
  ctx.page.drawText(opts.scopeLabel, {
    x: MARGIN + 20, y: ctx.y - 66, size: 9, font: ctx.font, color: rgb(0.86, 0.78, 0.6),
  });
  ctx.page.drawText(opts.periodLabel, {
    x: MARGIN + 20, y: ctx.y - 80, size: 9, font: ctx.font, color: rgb(0.82, 0.82, 0.82),
  });
  if (opts.comparisonLabel) {
    ctx.page.drawText(opts.comparisonLabel, {
      x: MARGIN + 20, y: ctx.y - 92, size: 8, font: ctx.fontItalic, color: rgb(0.7, 0.7, 0.7),
    });
  }
  ctx.y -= bandHeight + 26;
}

export interface BreakdownColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string;
  bold?: boolean;
}

/**
 * A table where each row carries a RAG status shown as a coloured rail.
 * Used for the aggregated breakdowns that replaced the raw row dumps.
 */
export function drawStatusTable<T extends { status?: RagStatus }>(
  ctx: DocContext,
  opts: { rows: T[]; columns: BreakdownColumn<T>[]; maxRows: number; emptyLabel: string; overflowLabel: (s: number, t: number) => string },
): void {
  if (opts.rows.length === 0) {
    if (!ensureSpace(ctx, 22)) return;
    ctx.page.drawText(opts.emptyLabel, { x: MARGIN, y: ctx.y, size: 9, font: ctx.fontItalic, color: PALETTE.muted });
    ctx.y -= 26;
    return;
  }

  if (!ensureSpace(ctx, 24)) return;
  let hx = MARGIN + 10;
  for (const col of opts.columns) {
    ctx.page.drawText(col.header, { x: hx, y: ctx.y, size: 8, font: ctx.fontBold, color: PALETTE.muted });
    hx += col.width;
  }
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y - 4 }, end: { x: ctx.width - MARGIN, y: ctx.y - 4 },
    thickness: 0.5, color: PALETTE.hairline,
  });
  ctx.y -= 17;

  const shown = opts.rows.slice(0, opts.maxRows);
  for (const row of shown) {
    if (!ensureSpace(ctx, 18)) return;
    const top = ctx.y;
    ctx.page.drawRectangle({ x: MARGIN, y: top - 4, width: ctx.width - MARGIN * 2, height: 16, color: PALETTE.surface });
    if (row.status) {
      ctx.page.drawRectangle({ x: MARGIN, y: top - 4, width: 2.5, height: 16, color: RAG_COLOR[row.status] });
    }
    let cx = MARGIN + 10;
    for (const col of opts.columns) {
      const font = col.bold ? ctx.fontBold : ctx.font;
      ctx.page.drawText(fitText(col.value(row), font, 8.5, col.width - 6), {
        x: cx, y: top, size: 8.5, font, color: PALETTE.body,
      });
      cx += col.width;
    }
    ctx.y -= 18;
  }

  if (opts.rows.length > shown.length) {
    if (!ensureSpace(ctx, 20)) return;
    ctx.y -= 4;
    ctx.page.drawText(opts.overflowLabel(shown.length, opts.rows.length), {
      x: MARGIN, y: ctx.y, size: 8, font: ctx.fontItalic, color: PALETTE.accent,
    });
    ctx.y -= 12;
  }
  ctx.y -= 14;
}

export function drawSectionHeader(ctx: DocContext, index: number, label: string): boolean {
  if (!ensureSpace(ctx, 44)) return false;
  ctx.page.drawText(`${index}. ${label}`, {
    x: MARGIN, y: ctx.y, size: 12, font: ctx.fontBold, color: PALETTE.ink,
  });
  // Gold lead-in over a teal rule: the section marker from the original design.
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y - 5 }, end: { x: MARGIN + 40, y: ctx.y - 5 },
    thickness: 1.6, color: PALETTE.accent,
  });
  ctx.page.drawLine({
    start: { x: MARGIN + 40, y: ctx.y - 5 }, end: { x: ctx.width - MARGIN, y: ctx.y - 5 },
    thickness: 1.2, color: PALETTE.teal,
  });
  ctx.y -= 24;
  return true;
}

export function drawRagDot(ctx: DocContext, x: number, y: number, status: RagStatus, radius = 3.4): void {
  ctx.page.drawCircle({ x, y, size: radius, color: RAG_COLOR[status] });
}

export interface KpiCard {
  label: string;
  value: string;
  /** Percentage change vs the previous period. null when there is no baseline. */
  deltaPct: number | null;
  /** Whether an increase is good. Drives arrow colour, not arrow direction. */
  higherIsBetter: boolean;
  status: RagStatus;
  sublabel?: string;
}

/**
 * KPI band: the entire executive summary. Two rows of three cards.
 * Each card carries its own delta vs prior period and a RAG dot.
 */
export function drawKpiGrid(ctx: DocContext, cards: KpiCard[]): void {
  const columns = 3;
  const gap = 12;
  const cardW = (ctx.width - MARGIN * 2 - gap * (columns - 1)) / columns;
  const cardH = 64;

  for (let i = 0; i < cards.length; i += columns) {
    if (!ensureSpace(ctx, cardH + gap)) return;
    const row = cards.slice(i, i + columns);

    row.forEach((card, col) => {
      const x = MARGIN + col * (cardW + gap);
      const top = ctx.y;

      ctx.page.drawRectangle({
        x, y: top - cardH, width: cardW, height: cardH,
        color: PALETTE.surfaceAlt, borderColor: PALETTE.hairline, borderWidth: 0.8,
      });
      // Status rail down the left edge — readable even in greyscale print.
      ctx.page.drawRectangle({
        x, y: top - cardH, width: 3, height: cardH, color: RAG_COLOR[card.status],
      });

      ctx.page.drawText(fitText(card.label.toUpperCase(), ctx.fontBold, 7, cardW - 22), {
        x: x + 12, y: top - 17, size: 7, font: ctx.fontBold, color: PALETTE.muted,
      });
      ctx.page.drawText(fitText(card.value, ctx.fontBold, 19, cardW - 22), {
        x: x + 12, y: top - 40, size: 19, font: ctx.fontBold, color: PALETTE.ink,
      });

      const caption = card.sublabel ?? '';
      if (caption) {
        ctx.page.drawText(fitText(caption, ctx.font, 7, cardW - 22), {
          x: x + 12, y: top - 54, size: 7, font: ctx.font, color: PALETTE.muted,
        });
      }
      drawDeltaBadge(ctx, x + cardW - 14, top - 15, card.deltaPct, card.higherIsBetter);
    });

    ctx.y -= cardH + gap;
  }
  ctx.y -= 8;
}

/**
 * Delta vs previous period, right-aligned to `xRight`.
 * Arrow direction follows the sign; colour follows whether that sign is good.
 */
export function drawDeltaBadge(
  ctx: DocContext, xRight: number, y: number, deltaPct: number | null, higherIsBetter: boolean,
): void {
  if (deltaPct === null || !Number.isFinite(deltaPct)) {
    const label = 'n/d';
    const w = ctx.font.widthOfTextAtSize(label, 7);
    ctx.page.drawText(label, { x: xRight - w, y, size: 7, font: ctx.font, color: PALETTE.muted });
    return;
  }

  const rounded = Math.round(deltaPct * 10) / 10;
  const flat = Math.abs(rounded) < 0.05;
  const arrow = flat ? '=' : rounded > 0 ? '^' : 'v';
  const improving = flat || (rounded > 0) === higherIsBetter;
  const color = flat ? PALETTE.muted : improving ? PALETTE.green : PALETTE.red;

  const label = `${arrow} ${Math.abs(rounded).toFixed(1)}%`;
  const w = ctx.fontBold.widthOfTextAtSize(label, 7.5);
  ctx.page.drawText(label, { x: xRight - w, y, size: 7.5, font: ctx.fontBold, color });
}

/**
 * Sparkline over the trailing periods. Flat-lines safely when all values are equal.
 */
export function drawSparkline(
  ctx: DocContext,
  opts: { x: number; y: number; width: number; height: number; values: number[]; color?: RGB },
): void {
  const { x, y, width, height, values } = opts;
  if (values.length < 2) return;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = width / (values.length - 1);
  const color = opts.color ?? PALETTE.ink;

  // A zero span would divide by zero; render the series along the midline instead.
  const yFor = (v: number) => (span === 0 ? y + height / 2 : y + ((v - min) / span) * height);

  for (let i = 0; i < values.length - 1; i++) {
    ctx.page.drawLine({
      start: { x: x + i * step, y: yFor(values[i]) },
      end: { x: x + (i + 1) * step, y: yFor(values[i + 1]) },
      thickness: 1.2, color,
    });
  }
  ctx.page.drawCircle({ x: x + width, y: yFor(values[values.length - 1]), size: 2, color });
}

export interface TrendRow {
  label: string;
  values: number[];
  current: string;
  status: RagStatus;
}

export function drawTrendStrip(ctx: DocContext, rows: TrendRow[]): void {
  const rowH = 26;
  for (const row of rows) {
    if (!ensureSpace(ctx, rowH)) return;
    const baseline = ctx.y - 16;

    drawRagDot(ctx, MARGIN + 4, baseline + 3, row.status);
    ctx.page.drawText(fitText(row.label, ctx.font, 9, 170), {
      x: MARGIN + 14, y: baseline, size: 9, font: ctx.font, color: PALETTE.body,
    });
    drawSparkline(ctx, {
      x: MARGIN + 200, y: baseline - 2, width: 200, height: 14,
      values: row.values, color: RAG_COLOR[row.status],
    });
    const w = ctx.fontBold.widthOfTextAtSize(row.current, 9);
    ctx.page.drawText(row.current, {
      x: ctx.width - MARGIN - w, y: baseline, size: 9, font: ctx.fontBold, color: PALETTE.ink,
    });
    ctx.y -= rowH;
  }
  ctx.y -= 8;
}

export interface ExceptionItem {
  status: RagStatus;
  title: string;
  detail: string;
  scope: string;
}

/** The "needs attention" page. An empty list is itself a meaningful result. */
export function drawExceptions(ctx: DocContext, items: ExceptionItem[], emptyLabel: string): void {
  if (items.length === 0) {
    if (!ensureSpace(ctx, 40)) return;
    ctx.page.drawRectangle({
      x: MARGIN, y: ctx.y - 30, width: ctx.width - MARGIN * 2, height: 30,
      color: rgb(0.94, 0.98, 0.95), borderColor: PALETTE.green, borderWidth: 0.8,
    });
    drawRagDot(ctx, MARGIN + 16, ctx.y - 15, 'green');
    ctx.page.drawText(emptyLabel, {
      x: MARGIN + 28, y: ctx.y - 18, size: 9.5, font: ctx.fontBold, color: PALETTE.green,
    });
    ctx.y -= 42;
    return;
  }

  for (const item of items) {
    const rowH = 34;
    if (!ensureSpace(ctx, rowH)) return;
    const top = ctx.y;

    ctx.page.drawRectangle({
      x: MARGIN, y: top - rowH + 4, width: ctx.width - MARGIN * 2, height: rowH - 4,
      color: PALETTE.surface,
    });
    ctx.page.drawRectangle({
      x: MARGIN, y: top - rowH + 4, width: 2.5, height: rowH - 4, color: RAG_COLOR[item.status],
    });

    ctx.page.drawText(fitText(item.title, ctx.fontBold, 9, 260), {
      x: MARGIN + 14, y: top - 14, size: 9, font: ctx.fontBold, color: PALETTE.ink,
    });
    ctx.page.drawText(fitText(item.detail, ctx.font, 8, 260), {
      x: MARGIN + 14, y: top - 25, size: 8, font: ctx.font, color: PALETTE.body,
    });

    const scope = fitText(item.scope, ctx.font, 8, 150);
    const w = ctx.font.widthOfTextAtSize(scope, 8);
    ctx.page.drawText(scope, {
      x: ctx.width - MARGIN - w - 10, y: top - 19, size: 8, font: ctx.font, color: PALETTE.muted,
    });

    ctx.y -= rowH;
  }
  ctx.y -= 10;
}

export interface TableColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string;
  bold?: boolean;
}

/**
 * Capped detail table. Renders at most `maxRows`, then states how many were
 * withheld and where to see them. This is what keeps the appendix bounded.
 */
export function drawCappedTable<T>(
  ctx: DocContext,
  opts: {
    rows: T[];
    columns: TableColumn<T>[];
    maxRows: number;
    emptyLabel: string;
    overflowLabel: (shown: number, total: number) => string;
  },
): void {
  if (opts.rows.length === 0) {
    if (!ensureSpace(ctx, 22)) return;
    ctx.page.drawText(opts.emptyLabel, {
      x: MARGIN, y: ctx.y, size: 9, font: ctx.fontItalic, color: PALETTE.muted,
    });
    ctx.y -= 26;
    return;
  }

  if (!ensureSpace(ctx, 24)) return;
  let x = MARGIN;
  for (const col of opts.columns) {
    ctx.page.drawText(col.header, { x, y: ctx.y, size: 8, font: ctx.fontBold, color: PALETTE.muted });
    x += col.width;
  }
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y - 4 }, end: { x: ctx.width - MARGIN, y: ctx.y - 4 },
    thickness: 0.5, color: PALETTE.hairline,
  });
  ctx.y -= 16;

  const shown = opts.rows.slice(0, opts.maxRows);
  for (const row of shown) {
    if (!ensureSpace(ctx, 15)) return;
    let cx = MARGIN;
    for (const col of opts.columns) {
      const font = col.bold ? ctx.fontBold : ctx.font;
      ctx.page.drawText(fitText(col.value(row), font, 8.5, col.width - 6), {
        x: cx, y: ctx.y, size: 8.5, font, color: PALETTE.body,
      });
      cx += col.width;
    }
    ctx.y -= 13;
  }

  if (opts.rows.length > shown.length) {
    if (!ensureSpace(ctx, 20)) return;
    ctx.y -= 4;
    ctx.page.drawText(opts.overflowLabel(shown.length, opts.rows.length), {
      x: MARGIN, y: ctx.y, size: 8, font: ctx.fontItalic, color: PALETTE.accent,
    });
    ctx.y -= 12;
  }
  ctx.y -= 14;
}

/** Page numbers + truncation notice. Call once, after all sections. */
export function finalizeFooters(ctx: DocContext, opts: { truncatedLabel: string; generatedLabel: string }): void {
  const pages = ctx.doc.getPages();
  pages.forEach((page, i) => {
    const { width } = page.getSize();
    const label = `${i + 1} / ${pages.length}`;
    const w = ctx.font.widthOfTextAtSize(label, 8);
    page.drawText(label, { x: width - MARGIN - w, y: 30, size: 8, font: ctx.font, color: PALETTE.muted });
    page.drawText(opts.generatedLabel, { x: MARGIN, y: 30, size: 8, font: ctx.font, color: PALETTE.muted });
  });

  if (ctx.truncated && pages.length > 0) {
    const last = pages[pages.length - 1];
    const { width } = last.getSize();
    last.drawText(opts.truncatedLabel, {
      x: MARGIN, y: 42, size: 8, font: ctx.fontItalic, color: PALETTE.accent,
      maxWidth: width - MARGIN * 2,
    });
  }
}

import type { Redaction, Segment } from "./types";

export const MASK_TOKEN = "〔已遮盖〕";

export function normalizeRange(selectionStart: number, selectionEnd: number, text: string) {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, text.length));
  const end = Math.max(0, Math.max(selectionStart, selectionEnd), 0);
  return { start, end: Math.min(end, text.length) };
}

/** 两个同片段遮盖范围是否重叠（端点相接不算重叠）。 */
export function rangesOverlap(a: Pick<Redaction, "start" | "end">, b: Pick<Redaction, "start" | "end">) {
  return a.start < b.end && b.start < a.end;
}

/** 找出与给定范围重叠的遮盖，可忽略某条自身。 */
export function findOverlap(
  segment: Pick<Segment, "redactions">,
  range: Pick<Redaction, "start" | "end">,
  ignoreId?: string,
) {
  return segment.redactions.find(
    (item) => item.id !== ignoreId && rangesOverlap(item, range),
  );
}

/** 偏移是否仍落在当前正文范围内。 */
export function rangeValidInText(redaction: Pick<Redaction, "start" | "end">, text: string) {
  return redaction.start >= 0 && redaction.end > redaction.start && redaction.end <= text.length;
}

/**
 * 确认状态是否仍然有效：
 * 片段正文或开始/结束时间码一改，确认快照就对不上，遮盖随即失效。
 */
export function isRedactionActive(
  redaction: Pick<Redaction, "confirmed" | "snapshot">,
  segment: Pick<Segment, "text" | "start" | "end">,
) {
  if (!redaction.confirmed || !redaction.snapshot) return false;
  return (
    redaction.snapshot.text === segment.text &&
    redaction.snapshot.start === segment.start &&
    redaction.snapshot.end === segment.end
  );
}

/**
 * 确认失效但偏移在当前正文中仍可解释（典型场景：只改了时间码）。
 * 此时校对员可在检查原文后直接重新确认，无需重选范围。
 */
export function isRedactionRecoverable(
  redaction: Redaction,
  segment: Pick<Segment, "text" | "start" | "end">,
) {
  return !isRedactionActive(redaction, segment) && rangeValidInText(redaction, segment.text);
}

export type RedactionState = "draft" | "active" | "stale" | "recoverable";

export function redactionState(redaction: Redaction, segment: Pick<Segment, "text" | "start" | "end">): RedactionState {
  if (isRedactionActive(redaction, segment)) return "active";
  if (!redaction.confirmed) return "draft";
  return rangeValidInText(redaction, segment.text) ? "recoverable" : "stale";
}

export const REDACTION_STATE_LABEL: Record<RedactionState, string> = {
  draft: "待确认",
  active: "已确认",
  stale: "已失效",
  recoverable: "待重新确认",
};

/** 公开导出实际生效的遮盖：已确认且未因正文/时间码变更而失效。 */
export function activeRedactions(segment: Pick<Segment, "redactions" | "text" | "start" | "end">): Redaction[] {
  return segment.redactions
    .filter((redaction) => isRedactionActive(redaction, segment))
    .sort((a, b) => a.start - b.start);
}

/** 把正文按遮盖范围切开，供界面渲染遮罩样式。 */
export function splitTextByRedactions(
  text: string,
  redactions: Pick<Redaction, "start" | "end">[],
): { text: string; masked: boolean }[] {
  const parts: { text: string; masked: boolean }[] = [];
  let cursor = 0;
  for (const redaction of [...redactions].sort((a, b) => a.start - b.start)) {
    const start = Math.max(redaction.start, cursor);
    const end = Math.min(redaction.end, text.length);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), masked: false });
    parts.push({ text: text.slice(start, end), masked: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), masked: false });
  if (!parts.length) parts.push({ text, masked: false });
  return parts;
}

/** 把正文按遮盖切开，并带上每条遮盖当前的状态，供列表渲染遮罩样式。 */
export function partitionTextByRedactionState(segment: Pick<Segment, "text" | "start" | "end" | "redactions">) {
  const parts: { text: string; redaction: Redaction | null; state: RedactionState | null }[] = [];
  let cursor = 0;
  for (const redaction of [...segment.redactions].sort((a, b) => a.start - b.start)) {
    if (!rangeValidInText(redaction, segment.text)) continue;
    const start = Math.max(redaction.start, cursor);
    const end = Math.min(redaction.end, segment.text.length);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: segment.text.slice(cursor, start), redaction: null, state: null });
    parts.push({ text: segment.text.slice(start, end), redaction, state: redactionState(redaction, segment) });
    cursor = end;
  }
  if (cursor < segment.text.length) parts.push({ text: segment.text.slice(cursor), redaction: null, state: null });
  if (!parts.length) parts.push({ text: segment.text, redaction: null, state: null });
  return parts;
}

/** 公开 SRT 使用：把生效遮盖整体替换成〔已遮盖〕。 */
export function applyRedactions(
  text: string,
  redactions: Pick<Redaction, "start" | "end">[],
): string {
  return splitTextByRedactions(text, redactions)
    .map((part) => (part.masked ? MASK_TOKEN : part.text))
    .join("");
}

export function describeRange(redaction: Pick<Redaction, "start" | "end">, text: string) {
  if (!rangeValidInText(redaction, text)) return null;
  return text.slice(redaction.start, redaction.end);
}

/** 整个轨道公开导出前尚未就绪的遮盖数量（未确认或已失效）。 */
export function pendingRedactions(segments: Segment[]) {
  return segments.reduce(
    (count, segment) =>
      count + segment.redactions.filter((redaction) => !isRedactionActive(redaction, segment)).length,
    0,
  );
}

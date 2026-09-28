import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import type { Confidence, PersistedEnvelope, ProjectData, Redaction, Segment, TranscriptTrack } from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

/** 遮盖仍有效：确认过、范围落在当前正文内，且正文与时间码均与确认时刻一致 */
function isRedactionLive(redaction: Redaction, segment: Pick<Segment, "text" | "start" | "end">) {
  return (
    redaction.confirmed &&
    redaction.anchorText === segment.text &&
    Number(redaction.anchorStart) === Number(segment.start) &&
    Number(redaction.anchorEnd) === Number(segment.end) &&
    redaction.start >= 0 &&
    redaction.end <= segment.text.length &&
    redaction.start < redaction.end
  );
}

/** 已确认但因正文或时间码变化而失效，需要重新确认 */
function isRedactionStale(redaction: Redaction, segment: Pick<Segment, "text" | "start" | "end">) {
  if (!redaction.confirmed) return false;
  return !isRedactionLive(redaction, segment);
}

/** 按当前正文长度夹取范围 */
const clampRange = (range: { start: number; end: number }, length: number) => {
  const end = Math.min(range.end, length);
  const start = Math.max(0, Math.min(range.start, end));
  return { start, end };
};

/** 与同片段其他遮盖是否重叠（首尾相接不算重叠）；失效遮盖按夹取后的范围参与比较 */
function overlapConflict(
  range: { start: number; end: number },
  redactions: Redaction[],
  segment: Pick<Segment, "text" | "start" | "end">,
  excludeId = "",
) {
  return redactions.find((item) => {
    if (item.id === excludeId) return false;
    const other = clampRange(item, segment.text.length);
    if (other.start >= other.end) return false;
    return range.start < other.end && other.start < range.end;
  });
}

/** 把 DOM 选区换算成相对片段正文纯文本的起止偏移 */
function selectionToOffsets(root: HTMLElement, range: AbstractRange) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += length;
    node = walker.nextNode();
  }
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** 公开文本：把当前有效遮盖合并相邻区间后替换为〔已遮盖〕 */
function applyRedactions(text: string, redactions: Redaction[], segment: Pick<Segment, "text" | "start" | "end">) {
  const ranges = redactions
    .filter((item) => isRedactionLive(item, segment))
    .map((item) => clampRange(item, text.length))
    .filter((item) => item.start < item.end)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  if (!merged.length) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    parts.push(text.slice(cursor, range.start), "〔已遮盖〕");
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

type RenderMark = { start: number; end: number; redaction: Redaction; status: "confirmed" | "stale" | "draft" };

/** 列表渲染用：把遮盖区间合并成互不重叠的标注段，确认态优先于失效态、失效态优先于草稿态 */
function buildRenderMarks(segment: Segment): RenderMark[] {
  const marks = segment.redactions
    .map((redaction) => {
      const range = clampRange(redaction, segment.text.length);
      return { ...range, redaction, status: isRedactionLive(redaction, segment) ? "confirmed" : isRedactionStale(redaction, segment) ? "stale" : "draft" } as RenderMark;
    })
    .filter((mark) => mark.start < mark.end);
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  const rank = { confirmed: 3, stale: 2, draft: 1 } as const;
  const result: RenderMark[] = [];
  for (const mark of marks) {
    const top = result.at(-1);
    if (top && mark.start < top.end) {
      if (rank[mark.status] > rank[top.status]) {
        top.redaction = mark.redaction;
        top.status = mark.status;
      }
      continue;
    }
    result.push({ ...mark });
  }
  return result;
}

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
        redactions: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
        redactions: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
        redactions: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [inspectorTab, setInspectorTab] = createSignal("correct");
  const [textSelection, setTextSelection] = createSignal<{ segmentId: string; start: number; end: number } | null>(null);
  const [bubblePos, setBubblePos] = createSignal<{ x: number; y: number } | null>(null);
  const [editorSelection, setEditorSelection] = createSignal<{ start: number; end: number } | null>(null);
  const [redactionErrors, setRedactionErrors] = createSignal<Record<string, string>>({});
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstTextRaw = segment.text.slice(0, safeCursor);
    const secondTextRaw = segment.text.slice(safeCursor);
    const firstText = firstTextRaw.trim();
    const secondText = secondTextRaw.trim();
    if (!firstText || !secondText) return;
    const ratio = firstTextRaw.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    // 遮盖按字符位置拆分平移；两端文字与时间码均已改变，原确认状态会自动失效。
    const firstLead = firstTextRaw.length - firstText.length;
    const secondLead = secondTextRaw.length - secondText.length;
    const firstRedactions: Redaction[] = [];
    const secondRedactions: Redaction[] = [];
    for (const redaction of segment.redactions) {
      const moved = { ...redaction };
      if (redaction.end <= safeCursor) {
        moved.start -= firstLead;
        moved.end -= firstLead;
        firstRedactions.push(moved);
      } else if (redaction.start >= safeCursor) {
        moved.start = moved.start - safeCursor - secondLead;
        moved.end = moved.end - safeCursor - secondLead;
        secondRedactions.push(moved);
      } else {
        // 跨界遮盖截到首段尾部，交由校对员重新确认。
        moved.start -= firstLead;
        moved.end = firstText.length;
        firstRedactions.push(moved);
      }
    }
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      current.redactions = firstRedactions;
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
          redactions: secondRedactions,
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    const firstPart = `${segment.text.trim()} `;
    // 下一段的遮盖偏移随合并后的文字平移；合并后正文/时间码与旧锚点不同，遮盖统一失效待确认。
    const shiftedNextRedactions = next.redactions.map((redaction) => ({
      ...redaction,
      start: redaction.start + firstPart.length,
      end: redaction.end + firstPart.length,
    }));
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.redactions = [...current.redactions, ...shiftedNextRedactions];
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const clearRedactionError = (segmentId: string) => {
    setRedactionErrors((errors) => {
      if (!errors[segmentId]) return errors;
      const next = { ...errors };
      delete next[segmentId];
      return next;
    });
  };

  /** 从选区划出一段遮盖范围；与其他遮盖重叠时拒绝保存并指出冲突 */
  const beginRedaction = (segmentId: string, range: { start: number; end: number }) => {
    const track = project().tracks.find((item) => item.id === project().activeTrackId);
    const target = track?.segments.find((item) => item.id === segmentId);
    if (!track || !target || range.start >= range.end) return;
    const safe = clampRange(range, target.text.length);
    if (safe.start >= safe.end) return;
    const conflictItem = overlapConflict(safe, target.redactions, target);
    if (conflictItem) {
      const conflictRange = clampRange(conflictItem, target.text.length);
      const conflictIndex = target.redactions.indexOf(conflictItem) + 1;
      const preview = target.text.slice(conflictRange.start, Math.min(conflictRange.end, conflictRange.start + 12));
      setRedactionErrors((errors) => ({
        ...errors,
        [segmentId]: `与第 ${conflictIndex} 处遮盖范围（“${preview}…”）重叠，请先调整或删除冲突范围。`,
      }));
      setLastAction("遮盖范围重叠，已拒绝保存");
      return;
    }
    commit("划出遮盖范围", (draft) => {
      const current = draft.tracks
        .find((item) => item.id === draft.activeTrackId)
        ?.segments.find((item) => item.id === segmentId);
      current?.redactions.push({
        id: uid("red"),
        start: safe.start,
        end: safe.end,
        reason: "",
        confirmed: false,
        anchorText: "",
        anchorStart: 0,
        anchorEnd: 0,
        createdAt: new Date().toISOString(),
      });
    });
    clearRedactionError(segmentId);
    setSelectedId(segmentId);
    setInspectorTab("redact");
    setTextSelection(null);
    setBubblePos(null);
    setEditorSelection(null);
  };

  const beginRedactionFromList = () => {
    const selection = textSelection();
    if (!selection) return;
    beginRedaction(selection.segmentId, selection);
  };

  const beginRedactionFromEditor = () => {
    const segment = activeSegment();
    const selection = editorSelection();
    if (!segment || !selection) return;
    beginRedaction(segment.id, selection);
  };

  const confirmRedaction = (redactionId: string) => {
    const segmentId = selectedId();
    const track = project().tracks.find((item) => item.id === project().activeTrackId);
    const target = track?.segments.find((item) => item.id === segmentId);
    if (!track || !target) return;
    const redaction = target.redactions.find((item) => item.id === redactionId);
    if (!redaction) return;
    if (!redaction.reason.trim()) {
      setRedactionErrors((errors) => ({ ...errors, [segmentId]: "请先填写遮盖原因，再确认保存。" }));
      return;
    }
    const safe = clampRange(redaction, target.text.length);
    if (safe.start >= safe.end) {
      setRedactionErrors((errors) => ({ ...errors, [segmentId]: "遮盖范围已超出当前正文，请删除后重新划出。" }));
      return;
    }
    const conflictItem = overlapConflict(safe, target.redactions, target, redactionId);
    if (conflictItem) {
      const conflictIndex = target.redactions.indexOf(conflictItem) + 1;
      setRedactionErrors((errors) => ({
        ...errors,
        [segmentId]: `与第 ${conflictIndex} 处遮盖范围重叠，无法确认，请先消除冲突。`,
      }));
      setLastAction("遮盖范围重叠，已拒绝确认");
      return;
    }
    commit("确认遮盖范围", (draft) => {
      const current = draft.tracks
        .find((item) => item.id === draft.activeTrackId)
        ?.segments.find((item) => item.id === segmentId);
      const item = current?.redactions.find((entry) => entry.id === redactionId);
      if (!current || !item) return;
      item.start = safe.start;
      item.end = safe.end;
      item.confirmed = true;
      item.anchorText = current.text;
      item.anchorStart = current.start;
      item.anchorEnd = current.end;
    });
    clearRedactionError(segmentId);
  };

  const deleteRedaction = (redactionId: string) => {
    const segmentId = selectedId();
    commit("删除遮盖范围", (draft) => {
      const current = draft.tracks
        .find((item) => item.id === draft.activeTrackId)
        ?.segments.find((item) => item.id === segmentId);
      if (!current) return;
      current.redactions = current.redactions.filter((item) => item.id !== redactionId);
    });
    clearRedactionError(segmentId);
  };

  const editRedactionReason = (redactionId: string, reason: string) => {
    const segmentId = selectedId();
    commit("更新遮盖原因", (draft) => {
      const current = draft.tracks
        .find((item) => item.id === draft.activeTrackId)
        ?.segments.find((item) => item.id === segmentId);
      const item = current?.redactions.find((entry) => entry.id === redactionId);
      if (item) item.reason = reason;
    });
  };

  const buildSrt = (publicExport: boolean) => {
    const track = activeTrack();
    return track.segments
      .map((segment, index) => {
        const speaker = speakerById(segment.speakerId)?.name ?? "未知";
        const body = publicExport ? applyRedactions(segment.text, segment.redactions, segment) : segment.text;
        return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${body}\n`;
      })
      .join("\n");
  };

  const exportSrt = () => {
    downloadText(`${project().title}-${activeTrack().name}.srt`, buildSrt(false), "application/x-subrip;charset=utf-8");
    setLastAction("已导出普通 SRT（保留原话）");
  };

  const exportPublicSrt = () => {
    downloadText(`${project().title}-${activeTrack().name}-公开.srt`, buildSrt(true), "application/x-subrip;charset=utf-8");
    setLastAction("已导出公开 SRT（已遮盖范围替换为〔已遮盖〕）");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  const syncBubbleFromSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setBubblePos(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setBubblePos(null);
      return;
    }
    setBubblePos({ x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleSelectionChange = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setTextSelection(null);
      setBubblePos(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const root = (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as HTMLElement)
      : range.startContainer.parentElement)?.closest("[data-segment-text]") as HTMLElement | null;
    if (!root || !root.contains(range.endContainer)) {
      setTextSelection(null);
      setBubblePos(null);
      return;
    }
    const offsets = selectionToOffsets(root, range);
    if (!offsets || offsets.start >= offsets.end) {
      setTextSelection(null);
      setBubblePos(null);
      return;
    }
    setTextSelection({ segmentId: root.dataset.segmentText ?? "", ...offsets });
    syncBubbleFromSelection();
  };

  const syncEditorSelection = () => {
    const editor = editorRef;
    if (!editor || document.activeElement !== editor) {
      setEditorSelection(null);
      return;
    }
    if (editor.selectionStart < editor.selectionEnd) {
      setEditorSelection({ start: editor.selectionStart, end: editor.selectionEnd });
    } else {
      setEditorSelection(null);
    }
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("scroll", syncBubbleFromSelection, true);
    window.addEventListener("resize", syncBubbleFromSelection);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.removeEventListener("scroll", syncBubbleFromSelection, true);
      window.removeEventListener("resize", syncBubbleFromSelection);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  // 切换片段时清掉上一个片段 textarea 的选区缓存，避免“遮盖选中”串段。
  createEffect(() => {
    selectedId();
    setEditorSelection(null);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={textSelection() && bubblePos()}>
        {(getSelectionInfo) => (
          <button
            class="selection-bubble"
            style={{
              left: `${getSelectionInfo()!.x}px`,
              top: `${getSelectionInfo()!.y - 8}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={beginRedactionFromList}
          >
            ⛿ 遮盖所选
          </button>
        )}
      </Show>

      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-quiet" title="普通导出：保留原话，供内部校对与草稿使用" onClick={exportSrt}>导出 SRT</button>
          <button class="btn btn-primary" title="公开导出：已确认遮盖范围替换为〔已遮盖〕" onClick={exportPublicSrt}>导出公开 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.redactions.some((item) => isRedactionLive(item, segment))}><span class="pill redacted">⛿ 已遮盖 {segment.redactions.filter((item) => isRedactionLive(item, segment)).length}</span></Show>
                      <Show when={segment.redactions.some((item) => isRedactionStale(item, segment))}><span class="pill redaction-stale">遮盖待确认</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p data-segment-text={segment.id}>
                      {(() => {
                        const marks = buildRenderMarks(segment);
                        const pieces: { text: string; mark?: RenderMark }[] = [];
                        let cursor = 0;
                        for (const mark of marks) {
                          if (mark.start > cursor) pieces.push({ text: segment.text.slice(cursor, mark.start) });
                          pieces.push({ text: segment.text.slice(mark.start, mark.end), mark });
                          cursor = mark.end;
                        }
                        if (cursor < segment.text.length) pieces.push({ text: segment.text.slice(cursor) });
                        return pieces.map((piece) =>
                          piece.mark ? (
                            <mark
                              class={`redaction-mark ${piece.mark.status}`}
                              title={
                                piece.mark.status === "confirmed"
                                  ? `已确认遮盖：${piece.mark.redaction.reason}`
                                  : piece.mark.status === "stale"
                                    ? "遮盖已失效：正文或时间码已变化，需重新确认"
                                    : "待确认遮盖：请在右侧填写原因并确认"
                              }
                            >
                              {piece.text}
                            </mark>
                          ) : (
                            <span>{piece.text}</span>
                          ),
                        );
                      })()}
                    </p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs value={inspectorTab()} onChange={setInspectorTab} class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="redact">
                    遮盖{" "}
                    <span classList={{ "redact-count": segment().redactions.some((item) => isRedactionLive(item, segment())) }}>
                      {segment().redactions.filter((item) => isRedactionLive(item, segment())).length}
                    </span>
                  </Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                    onSelect={syncEditorSelection}
                    onKeyUp={syncEditorSelection}
                    onMouseUp={syncEditorSelection}
                    onInput={() => setEditorSelection(null)}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例；选中文字可在“遮盖”页划出公开前要遮蔽的范围。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="redact" class="tab-content comments-content">
                  <div class="content-title">
                    <h3>公开前遮盖</h3>
                    <p>在片段列表或上方转写文本中选中要遮蔽的文字，划出范围后填写原因并确认。仅“导出公开 SRT”会替换为〔已遮盖〕。</p>
                  </div>

                  <div class="redaction-compose">
                    <button
                      class="wide-action"
                      disabled={!editorSelection()}
                      onClick={beginRedactionFromEditor}
                      title={editorSelection() ? undefined : "请先在上方转写文本中选中文字"}
                    >
                      <span>⛿</span> 遮盖选中的 {editorSelection() ? editorSelection()!.end - editorSelection()!.start : 0} 个字
                    </button>
                    <Show when={textSelection() && textSelection()!.segmentId !== segment().id}>
                      <div class="hint">已在列表其他片段选中文字，点击片段旁浮出的“遮盖所选”即可。</div>
                    </Show>
                  </div>

                  <Show when={redactionErrors()[segment().id]}>
                    {(message) => <div class="redaction-error" role="alert">{message()}</div>}
                  </Show>

                  <div class="redaction-list">
                    <For
                      each={[...segment().redactions].sort((a, b) => a.start - b.start)}
                      fallback={<div class="mini-empty">该片段还没有遮盖范围。选中正文文字后划出第一处。</div>}
                    >
                      {(redaction) => {
                        const live = () => isRedactionLive(redaction, segment());
                        const stale = () => isRedactionStale(redaction, segment());
                        const range = () => clampRange(redaction, segment().text.length);
                        const preview = () =>
                          range().start < range().end ? segment().text.slice(range().start, range().end) : "（范围已超出当前正文）";
                        return (
                          <article class={`redaction-card ${live() ? "live" : stale() ? "stale" : "draft"}`}>
                            <header>
                              <span class={`redaction-state ${live() ? "live" : stale() ? "stale" : "draft"}`}>
                                {live() ? "✓ 已确认" : stale() ? "⚠ 已失效·需重新确认" : "待确认"}
                              </span>
                              <button class="resolve-link danger" onClick={() => deleteRedaction(redaction.id)}>删除</button>
                            </header>
                            <p class="redaction-quote" title={`字符 ${redaction.start}–${redaction.end}`}>“{preview()}”</p>
                            <label class="field-label" for={`reason-${redaction.id}`}>遮盖原因</label>
                            <textarea
                              id={`reason-${redaction.id}`}
                              rows="2"
                              placeholder="例如：家属要求隐去真实姓名…"
                              value={redaction.reason}
                              onInput={(event) => editRedactionReason(redaction.id, event.currentTarget.value)}
                            />
                            <Show when={stale()}>
                              <div class="redaction-warning">
                                片段正文或时间码在确认后发生变化，原有遮盖已失效。核对范围后重新确认，才会进入公开导出。
                              </div>
                            </Show>
                            <Show when={!live()}>
                              <button
                                class="btn btn-primary redaction-confirm"
                                disabled={range().start >= range().end}
                                onClick={() => confirmRedaction(redaction.id)}
                              >
                                {redaction.confirmed ? "重新确认遮盖" : "确认遮盖"}
                              </button>
                            </Show>
                          </article>
                        );
                      }}
                    </For>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}

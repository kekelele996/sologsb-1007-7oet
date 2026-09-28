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
import {
  REDACTION_STATE_LABEL,
  activeRedactions,
  applyRedactions,
  describeRange,
  findOverlap,
  isRedactionActive,
  normalizeRange,
  partitionTextByRedactionState,
  pendingRedactions,
  rangeValidInText,
  redactionState,
} from "../redactions";
import type {
  Confidence,
  PersistedEnvelope,
  ProjectData,
  Redaction,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

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
  const [editorSelection, setEditorSelection] = createSignal<{ start: number; end: number }>({ start: 0, end: 0 });
  const [inspectorTab, setInspectorTab] = createSignal("correct");
  const [redactionMessage, setRedactionMessage] = createSignal<{ tone: "error" | "info"; text: string } | null>(null);
  const [reasonDrafts, setReasonDrafts] = createSignal<Record<string, string>>({});
  const [publicExportOpen, setPublicExportOpen] = createSignal(false);
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

  // 切换片段时清掉仅属于上一个片段的选区提示与遮盖冲突提示。
  createEffect(() => {
    selectedId();
    setEditorSelection({ start: 0, end: 0 });
    setRedactionMessage(null);
    queueMicrotask(syncEditorSelection);
  });

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
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
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
          // 拆出的新片段不带遮盖；前半段正文/结束时间已变，其原遮盖会自动失效待重新确认。
          redactions: [],
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
    commitSegment("合并下一片段", (current, draft) => {
      // 合并后正文为“前段 + 空格 + 后段”，后段遮盖的偏移需要整体平移。
      const nextOffsetBase = `${current.text.trim()} `.length;
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      // 合并会改写正文：被合并片段的遮盖保留原因与范围记录，但确认状态全部失效。
      current.redactions = [
        ...current.redactions.map((redaction) => ({ ...redaction, confirmed: false, snapshot: null })),
        ...next.redactions.map((redaction) => ({
          ...redaction,
          start: redaction.start + nextOffsetBase,
          end: redaction.end + nextOffsetBase,
          confirmed: false,
          snapshot: null,
        })),
      ];
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

  const locateSegment = (draft: ProjectData, segmentId: string) => {
    for (const track of draft.tracks) {
      const found = track.segments.find((item) => item.id === segmentId);
      if (found) return found;
    }
    return undefined;
  };

  const syncEditorSelection = () => {
    const textarea = editorRef;
    if (!textarea) return;
    setEditorSelection({ start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 });
  };

  /** 校对员选中片段正文后划出遮盖范围：范围必须非空且不得与既有遮盖重叠。 */
  const createRedactionFromSelection = () => {
    const segment = activeSegment();
    const textarea = editorRef;
    if (!segment || !textarea) return;
    const range = normalizeRange(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0, segment.text);
    if (range.end <= range.start) {
      setRedactionMessage({ tone: "error", text: "请先在上方“转写文本”中选中需要遮盖的文字，再划出范围。" });
      setInspectorTab("redact");
      return;
    }
    const conflict = findOverlap(segment, range);
    if (conflict) {
      const quote = describeRange(conflict, segment.text) ?? "失效范围";
      setRedactionMessage({
        tone: "error",
        text: `保存被拒绝：新范围（${segment.text.slice(range.start, range.end)}）与已有遮盖“${quote}”重叠，冲突范围为第 ${conflict.start + 1}–${conflict.end} 字。`,
      });
      setInspectorTab("redact");
      return;
    }
    const redactionId = uid("red");
    commit("划出遮盖范围", (draft) => {
      const target = locateSegment(draft, segment.id);
      target?.redactions.push({
        id: redactionId,
        start: range.start,
        end: range.end,
        reason: "",
        confirmed: false,
        snapshot: null,
        createdAt: new Date().toISOString(),
      });
    });
    setRedactionMessage({ tone: "info", text: "范围已划出，请填写不披露原因并确认；确认后才会在公开 SRT 中生效。" });
    setInspectorTab("redact");
  };

  const reasonDraftValue = (redaction: Redaction) =>
    Object.prototype.hasOwnProperty.call(reasonDrafts(), redaction.id) ? reasonDrafts()[redaction.id] : redaction.reason;

  const setReasonDraft = (redactionId: string, reason: string) => {
    setReasonDrafts((drafts) => ({ ...drafts, [redactionId]: reason }));
  };

  const commitReasonDraft = (redactionId: string) => {
    const drafts = reasonDrafts();
    if (!Object.prototype.hasOwnProperty.call(drafts, redactionId)) return;
    const draftReason = drafts[redactionId];
    const current = activeSegment()?.redactions.find((item) => item.id === redactionId)?.reason ?? "";
    setReasonDrafts((items) => {
      const next = { ...items };
      delete next[redactionId];
      return next;
    });
    if (draftReason !== current) {
      const segmentId = selectedId();
      commit("填写遮盖原因", (projectDraft) => {
        const redaction = locateSegment(projectDraft, segmentId)?.redactions.find((item) => item.id === redactionId);
        if (redaction) redaction.reason = draftReason;
      });
    }
  };

  /** 确认（或在正文/时间码改动后重新确认）遮盖。重叠、空原因、范围失效一律拒绝。 */
  const confirmRedaction = (redactionId: string) => {
    // 先把原因输入框里尚未失焦的草稿落进项目状态。
    commitReasonDraft(redactionId);
    const segment = activeSegment();
    if (!segment) return;
    const redaction = segment.redactions.find((item) => item.id === redactionId);
    if (!redaction) return;
    if (!redaction.reason.trim()) {
      setRedactionMessage({ tone: "error", text: "请先填写受访者不愿披露的原因，再确认遮盖。" });
      return;
    }
    if (!rangeValidInText(redaction, segment.text)) {
      setRedactionMessage({
        tone: "error",
        text: "原范围已无法对应当前正文（正文已被改写）。请改用“采用当前选区”重选文字后确认。",
      });
      return;
    }
    const conflict = findOverlap(segment, redaction, redactionId);
    if (conflict) {
      const quote = describeRange(conflict, segment.text) ?? "失效范围";
      setRedactionMessage({
        tone: "error",
        text: `保存被拒绝：该范围与另一条遮盖“${quote}”重叠（第 ${conflict.start + 1}–${conflict.end} 字）。`,
      });
      return;
    }
    commit("确认遮盖范围", (draft) => {
      const target = locateSegment(draft, segment.id);
      const targetRedaction = target?.redactions.find((item) => item.id === redactionId);
      if (!target || !targetRedaction) return;
      targetRedaction.confirmed = true;
      targetRedaction.snapshot = { text: target.text, start: target.start, end: target.end };
    });
    setRedactionMessage(null);
  };

  const deleteRedaction = (redactionId: string) => {
    const segmentId = selectedId();
    commit("删除遮盖", (draft) => {
      const target = locateSegment(draft, segmentId);
      if (!target) return;
      target.redactions = target.redactions.filter((item) => item.id !== redactionId);
    });
    setRedactionMessage(null);
  };

  /** 正文改动导致偏移失效后，用校对员当前在文本框中的选区重新指定范围。 */
  const adoptEditorSelectionForRedaction = (redactionId: string) => {
    const segment = activeSegment();
    const textarea = editorRef;
    if (!segment || !textarea) return;
    const range = normalizeRange(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0, segment.text);
    if (range.end <= range.start) {
      setRedactionMessage({ tone: "error", text: "请先在“校对”页的转写文本中重新选中要遮盖的文字。" });
      return;
    }
    const conflict = findOverlap(segment, range, redactionId);
    if (conflict) {
      const quote = describeRange(conflict, segment.text) ?? "失效范围";
      setRedactionMessage({
        tone: "error",
        text: `保存被拒绝：当前选区（${segment.text.slice(range.start, range.end)}）与已有遮盖“${quote}”重叠。`,
      });
      return;
    }
    commit("重选遮盖范围", (draft) => {
      const target = locateSegment(draft, segment.id);
      const targetRedaction = target?.redactions.find((item) => item.id === redactionId);
      if (!target || !targetRedaction) return;
      targetRedaction.start = range.start;
      targetRedaction.end = range.end;
      // 正文/时间码已变，旧确认作废，需要重新确认。
      targetRedaction.confirmed = false;
      targetRedaction.snapshot = null;
    });
    setRedactionMessage({ tone: "info", text: "范围已按当前选区更新，请重新确认。" });
  };

  const buildSrt = (publicVersion: boolean) => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      // 公开导出：仅已确认且未因正文/时间码变更失效的遮盖会替换成〔已遮盖〕；
      // 普通导出（草稿）一律保留原话。
      const text = publicVersion
        ? applyRedactions(segment.text, activeRedactions(segment))
        : segment.text;
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${text}\n`;
    });
    return lines.join("\n");
  };

  const exportSrt = () => {
    downloadText(
      `${project().title}-${activeTrack().name}.srt`,
      buildSrt(false),
      "application/x-subrip;charset=utf-8",
    );
    setLastAction("已导出普通 SRT（保留原话）");
  };

  const exportPublicSrt = () => {
    downloadText(
      `${project().title}-${activeTrack().name}-公开版.srt`,
      buildSrt(true),
      "application/x-subrip;charset=utf-8",
    );
    setPublicExportOpen(false);
    setLastAction("已导出公开 SRT（已确认范围显示〔已遮盖〕）");
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
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
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
    queueMicrotask(() => {
      editorRef?.focus();
      syncEditorSelection();
    });
  };

  return (
    <div class="app-shell">
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
          <button class="btn btn-quiet" onClick={exportSrt} title="普通导出：保留原话的草稿 SRT">导出 SRT</button>
          <button class="btn btn-primary" onClick={() => setPublicExportOpen(true)} title="公开导出：已确认遮盖显示〔已遮盖〕">导出公开 SRT</button>
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
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                      <Show when={activeRedactions(segment).length > 0}>
                        <span class="pill redact-active">〔{activeRedactions(segment).length} 处已遮盖〕</span>
                      </Show>
                      <Show when={segment.redactions.some((item) => !isRedactionActive(item, segment))}>
                        <span class="pill redact-pending">遮盖待处理</span>
                      </Show>
                    </div>
                    <p>
                      <For each={partitionTextByRedactionState(segment)}>
                        {(part) => (
                          <Show
                            when={part.state}
                            fallback={<>{part.text}</>}
                          >
                            {(state) => (
                              <span
                                class={`redact-mark redact-${state()}`}
                                title={state() === "active"
                                  ? part.redaction?.reason || "已遮盖"
                                  : REDACTION_STATE_LABEL[state()]}
                              >
                                {state() === "active" ? "〔已遮盖〕" : part.text}
                              </span>
                            )}
                          </Show>
                        )}
                      </For>
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
                <Tabs.List class="tab-list redact-tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="redact">遮盖 <span>{segment().redactions.length || ""}</span></Tabs.Trigger>
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
                    onSelect={syncEditorSelection}
                    onKeyUp={syncEditorSelection}
                    onMouseUp={syncEditorSelection}
                    onFocus={syncEditorSelection}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>
                  <div class="redact-compose">
                    <Show
                      when={editorSelection().end > editorSelection().start}
                      fallback={<span class="redact-hint">选中上方文字后可划出遮盖范围；正文或时间码一改，已确认遮盖会自动失效。</span>}
                    >
                      <span class="redact-selection">
                        已选中 “{segment().text.slice(editorSelection().start, editorSelection().end)}”（第 {editorSelection().start + 1}–{editorSelection().end} 字）
                      </span>
                    </Show>
                    <button class="redact-create-btn" onClick={createRedactionFromSelection}>▰ 遮盖所选文字</button>
                  </div>

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

                <Tabs.Content value="redact" class="tab-content redact-content">
                  <div class="content-title">
                    <h3>公开前遮盖</h3>
                    <p>在“校对”页选中片段正文即可划出范围；填写受访者不愿披露的原因并确认后，公开 SRT 中才会显示〔已遮盖〕。两个范围重叠会拒绝保存。</p>
                  </div>

                  <div class="redaction-summary">
                    <span><i class="dot active" /> 已确认 {segment().redactions.filter((item) => isRedactionActive(item, segment())).length}</span>
                    <span><i class="dot pending" /> 待处理 {segment().redactions.filter((item) => !isRedactionActive(item, segment())).length}</span>
                  </div>

                  <Show when={redactionMessage()}>
                    {(message) => (
                      <div class={`redaction-banner ${message().tone}`} role="alert">{message().text}</div>
                    )}
                  </Show>

                  <For each={segment().redactions} fallback={<div class="mini-empty">当前片段还没有遮盖。先在“校对”页选中要遮盖的文字。</div>}>
                    {(redaction) => {
                      const state = () => redactionState(redaction, segment());
                      const quote = () => describeRange(redaction, segment().text);
                      return (
                        <article class={`redaction-card state-${state()}`}>
                          <header>
                            <span class={`redaction-state state-${state()}`}>{REDACTION_STATE_LABEL[state()]}</span>
                            <span class="redaction-range">第 {redaction.start + 1}–{redaction.end} 字</span>
                          </header>

                          <div class="redaction-quote" title="遮盖范围内的原文（仅普通导出与草稿保留）">
                            {quote() ?? <em class="redaction-lost">范围已超出当前正文，请重新选区</em>}
                          </div>

                          <Show when={state() === "stale" || state() === "recoverable"}>
                            <div class="redaction-warning">
                              {state() === "recoverable"
                                ? "片段正文或时间码已修改，原遮盖确认已失效；请核对上方原文，无误后可直接重新确认。"
                                : "片段正文已修改，原范围无法对应；请到“校对”页重新选中文字后再确认。"}
                            </div>
                          </Show>

                          <label class="redaction-reason-label" for={`reason-${redaction.id}`}>不披露原因</label>
                          <textarea
                            id={`reason-${redaction.id}`}
                            rows="2"
                            placeholder="例如：受访者要求公开版本不出现家属真实姓名"
                            value={reasonDraftValue(redaction)}
                            onInput={(event) => setReasonDraft(redaction.id, event.currentTarget.value)}
                            onBlur={() => commitReasonDraft(redaction.id)}
                          />

                          <div class="redaction-actions">
                            <Show when={state() === "active"}>
                              <span class="redaction-ok">✓ 将在公开 SRT 中遮盖</span>
                            </Show>
                            <Show when={state() !== "active"}>
                              <button class="btn btn-primary" onClick={() => confirmRedaction(redaction.id)}>
                                {state() === "recoverable" ? "重新确认" : "确认遮盖"}
                              </button>
                            </Show>
                            <Show when={state() === "stale"}>
                              <button class="btn btn-quiet" onClick={() => adoptEditorSelectionForRedaction(redaction.id)}>采用当前选区</button>
                            </Show>
                            <button class="redaction-delete" onClick={() => deleteRedaction(redaction.id)}>删除</button>
                          </div>
                        </article>
                      );
                    }}
                  </For>
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

      <Dialog open={publicExportOpen()} onOpenChange={setPublicExportOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>导出公开 SRT</Dialog.Title>
            <Dialog.Description>
              已确认且仍然有效的遮盖会替换为〔已遮盖〕；普通导出与本地草稿始终保留原话。
            </Dialog.Description>
            <div class="export-preview">
              <div class="export-row">
                <strong>轨道</strong><span>{activeTrack().name}</span>
              </div>
              <div class="export-row">
                <strong>生效遮盖</strong>
                <span>{activeTrack().segments.reduce((count, item) => count + activeRedactions(item).length, 0)} 处</span>
              </div>
              <Show when={pendingRedactions(activeTrack().segments) > 0}>
                <div class="export-warning" role="alert">
                  还有 {pendingRedactions(activeTrack().segments)} 处遮盖未确认或已因正文/时间码修改失效，公开导出时这些位置会保留原话。请先在“遮盖”页处理。
                </div>
              </Show>
              <div class="export-sample">
                <small>效果示例</small>
                <For each={activeTrack().segments.filter((item) => activeRedactions(item).length > 0).slice(0, 2)}>
                  {(item) => (
                    <p>{formatTime(item.start, false)} → {formatTime(item.end, false)}<br />
                    {speakerById(item.speakerId)?.name ?? "未知"}：{applyRedactions(item.text, activeRedactions(item))}</p>
                  )}
                </For>
              </div>
            </div>
            <div class="dialog-footer export-footer">
              <button class="btn btn-quiet" onClick={() => setPublicExportOpen(false)}>取消</button>
              <button class="btn btn-primary" onClick={exportPublicSrt}>确认导出公开版</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

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

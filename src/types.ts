export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Redaction {
  id: string;
  /** 基于片段正文 UTF-16 码元的起始偏移（含） */
  start: number;
  /** 基于片段正文 UTF-16 码元的结束偏移（不含） */
  end: number;
  /** 确认遮盖时填写的原因 */
  reason: string;
  /** 是否已由校对员确认；只有确认过的遮盖会进入公开导出 */
  confirmed: boolean;
  /** 确认时刻的正文快照，用于在正文变化后让遮盖失效 */
  anchorText: string;
  /** 确认时刻的时间码快照，用于在时间码变化后让遮盖失效 */
  anchorStart: number;
  anchorEnd: number;
  createdAt: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
  redactions: Redaction[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

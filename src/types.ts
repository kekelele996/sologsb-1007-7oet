export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/** 确认遮盖那一刻片段正文与时间码的快照，用于事后判断遮盖是否失效。 */
export interface RedactionSnapshot {
  text: string;
  start: number;
  end: number;
}

export interface Redaction {
  id: string;
  /** 相对片段正文的字符偏移区间，左闭右开。 */
  start: number;
  end: number;
  /** 校对员填写的不披露原因。 */
  reason: string;
  /** 只有确认过的遮盖才会在公开 SRT 中生效。 */
  confirmed: boolean;
  /** 未确认或已失效时为 null。 */
  snapshot: RedactionSnapshot | null;
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

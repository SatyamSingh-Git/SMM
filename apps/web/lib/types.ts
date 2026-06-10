export type Platform = "instagram" | "threads";

export type PostType =
  | "ig_feed"
  | "ig_carousel"
  | "ig_reel"
  | "ig_story"
  | "threads_post"
  | "threads_reply_chain";

export type PostStatus =
  | "draft"
  | "queued"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type Account = {
  id: string;
  platform: Platform;
  platformUserId: string;
  username: string | null;
};

export type MediaAsset = {
  id: string;
  type: "image" | "video";
  storageKey: string;
  publicUrl: string;
  mimeType: string;
  sizeBytes: number;
  widthPx?: number | null;
  heightPx?: number | null;
};

export type Post = {
  id: string;
  accountId: string;
  platform: Platform;
  type: PostType;
  caption: string | null;
  scheduledAt: string | null;
  status: PostStatus;
  platformPostId: string | null;
  platformUrl: string | null;
  aiGenerated: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  assets: { position: number; asset: MediaAsset }[];
};

// ---- Dashboard ----

export type DashboardKpis = {
  followers: {
    current: number;
    // null = not enough history yet. UI shows "tracking started X days ago".
    delta14d: number | null;
    historyDays: number;
  };
  reach7d: number;
  engagementRate: number | null;
  shareRate7d: number | null;
  saveRate7d: number | null;
  postsPublished7d: number;
  repliesHandled: {
    total: number;
    replied: number;
    skipped: number;
    failed: number;
  };
};

export type BestSlot = {
  dayOfWeek: number; // 0 = Monday
  hourIst: number; // 0-23 IST
  avgEngagement: number;
  samples: number;
};
export type BestTimes = {
  slots: BestSlot[];
  minSamples: number;
  totalPosts: number;
};

export type TopPostRow = {
  id: string;
  platform: Platform;
  type: PostType;
  caption: string | null;
  publishedAt: string | null;
  platformUrl: string | null;
  thumbnailUrl: string | null;
  engagement: number;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
};

export type AiWinOrWarn = { title: string; detail: string; evidence?: string };
export type AiTryNext = { title: string; why: string; exampleCaption?: string };

export type DashboardAiInsights = {
  weeklyFocus: string;
  wins: AiWinOrWarn[];
  warnings: AiWinOrWarn[];
  tryNext: AiTryNext[];
  scoreCard: {
    consistency: { grade: "A" | "B" | "C" | "D"; note: string };
    engagement: { grade: "A" | "B" | "C" | "D"; note: string };
    growth: { grade: "A" | "B" | "C" | "D"; note: string };
  };
  generatedAt: string;
  basedOn: { postsAnalyzed: number; daysOfData: number };
};

export type TypeBreakdownRow = {
  type: PostType;
  count: number;
  avgEngagement: number;
  avgReach: number | null;
};

export type FollowerTrendPoint = { date: string; followers: number };

// ---- Tier 1 dashboard sections ----

export type SentimentBucket = {
  label: string;
  count: number;
  examples: string[];
};
export type TopicCluster = {
  theme: string;
  count: number;
  examples: string[];
  contentIdea: string;
};
export type CommentThemes = {
  totalAnalyzed: number;
  sentimentBreakdown: SentimentBucket[];
  topicClusters: TopicCluster[];
  insight: string;
  generatedAt: string | null;
  cached: boolean;
  empty?: boolean;
};

export type SuperFan = {
  authorPlatformId: string | null;
  authorUsername: string | null;
  commentCount: number;
  lastCommentAt: string;
  lastCommentText: string;
  postsEngagedOn: number;
};

export type CaptionPatternObservation = {
  title: string;
  detail: string;
  evidence: string;
};
export type CaptionPatterns = {
  doMore: CaptionPatternObservation[];
  doLess: CaptionPatternObservation[];
  templateExamples: string[];
  // Number of posts the analyzer actually had data for. 0 = pool was empty.
  postsAnalyzed?: number;
  // Human-readable explanation when the pool was empty.
  note?: string;
  generatedAt: string | null;
  cached: boolean;
  empty?: boolean;
};

export type EngagementMix = {
  platform: Platform | "all";
  days: number;
  postsCounted: number;
  totals: {
    likes: number;
    comments: number;
    saves: number;
    shares: number;
    reposts: number;
    quotes: number;
  };
  percentages: {
    likes: number;
    comments: number;
    saves: number;
    shares: number;
  };
  verdict:
    | "save-heavy"
    | "share-heavy"
    | "comment-heavy"
    | "like-heavy"
    | "mixed"
    | "no-data";
  interpretation: string;
};

export type MomentumPost = {
  postId: string;
  platform: Platform;
  type: PostType;
  platformUrl: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string;
  engagement: number;
  baseline: number;
  multiple: number;
};

// Stage 2: auto-reply engagement on Threads.
export type EngagementStatus =
  | "new"
  | "queued"
  | "replying"
  | "replied"
  | "skipped"
  | "failed";

export type EngagementComment = {
  id: string;
  platform: Platform;
  platformCommentId: string;
  platformPostId: string;
  postCaption: string | null;
  authorUsername: string | null;
  text: string;
  receivedAt: string;
  // Last time the row's status changed — used to show "replied X ago" on
  // replied rows (we don't store a separate repliedAt column).
  updatedAt: string;
  status: EngagementStatus;
  agentReplyText: string | null;
  agentPlatformReplyId: string | null;
  lastError: string | null;
};

// "What to Write" — a post idea generated in the creator's voice, inspired by
// another post. Same shape as a caption suggestion (caption + optional hashtags).
export type InspireSuggestion = { caption: string; hashtags: string[] };

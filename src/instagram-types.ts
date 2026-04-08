// ── Instagram bookmark types ────────────────────────────────────────────────

export type InstagramMediaType = 'image' | 'video' | 'carousel' | 'reel';

export interface InstagramMediaItem {
  id: string;
  type: 'image' | 'video';
  url: string;
  width?: number;
  height?: number;
  /** Video-specific fields */
  videoUrl?: string;
  videoDuration?: number;
  /** Audio track URL (reels) */
  audioUrl?: string;
  audioTitle?: string;
  audioArtist?: string;
}

export interface InstagramAuthorSnapshot {
  id: string;
  username: string;
  fullName?: string;
  profilePicUrl?: string;
  isVerified?: boolean;
  isPrivate?: boolean;
}

export interface InstagramEngagement {
  likeCount?: number;
  commentCount?: number;
  viewCount?: number;
  playCount?: number;
  shareCount?: number;
}

export interface InstagramSavedPost {
  /** Internal record ID (= Instagram media PK) */
  id: string;
  /** Instagram shortcode (the part in the URL) */
  shortcode: string;
  /** Post type */
  mediaType: InstagramMediaType;
  /** Full URL */
  url: string;
  /** Caption text */
  caption: string;
  /** Author info */
  author: InstagramAuthorSnapshot;
  /** Post timestamp */
  postedAt: string | null;
  /** When we synced it */
  syncedAt: string;
  /** Engagement metrics */
  engagement?: InstagramEngagement;
  /** Media items (images/videos in post) */
  mediaItems: InstagramMediaItem[];
  /** Location name if tagged */
  location?: string;
  /** Hashtags extracted from caption */
  hashtags: string[];
  /** Mentioned usernames */
  mentions: string[];
  /** Alt text on images */
  accessibilityCaption?: string;
  /** Audio info for reels */
  audio?: {
    id: string;
    title: string;
    artist?: string;
    url?: string;
  };
  /** Is this a reel? */
  isReel: boolean;
  /** Tagged users */
  taggedUsers: string[];
}

export interface InstagramCacheMeta {
  provider: 'instagram';
  schemaVersion: number;
  lastFullSyncAt?: string;
  lastIncrementalSyncAt?: string;
  totalSavedPosts: number;
}

export interface InstagramSyncState {
  provider: 'instagram';
  lastRunAt?: string;
  totalRuns: number;
  totalAdded: number;
  lastAdded: number;
  lastSeenIds: string[];
  stopReason?: string;
}

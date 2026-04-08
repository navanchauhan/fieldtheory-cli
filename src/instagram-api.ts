/**
 * Instagram saved-posts sync engine.
 *
 * Uses Instagram's private web API (`/api/v1/feed/saved/posts/`) with
 * session cookies extracted from Chrome. Follows the same patterns as
 * the Twitter GraphQL sync: JSONL cache, incremental merging, checkpointing.
 */
import { ensureDir, readJsonLines, writeJsonLines, readJson, writeJson, pathExists } from './fs.js';
import {
  ensureDataDir,
  instagramCachePath,
  instagramMetaPath,
  instagramSyncStatePath,
} from './paths.js';
import { loadChromeSessionConfig } from './config.js';
import { extractInstagramCookies } from './instagram-cookies.js';
import type {
  InstagramSavedPost,
  InstagramCacheMeta,
  InstagramSyncState,
  InstagramMediaItem,
  InstagramAuthorSnapshot,
  InstagramMediaType,
} from './instagram-types.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const IG_APP_ID = '936619743392459';

// ── Sync options & progress ──────────────────────────────────────────────

export interface InstagramSyncOptions {
  incremental?: boolean;
  maxPages?: number;
  delayMs?: number;
  maxMinutes?: number;
  stalePageLimit?: number;
  checkpointEvery?: number;
  browser?: string;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  /** Direct cookie overrides */
  sessionId?: string;
  csrfToken?: string;
  dsUserId?: string;
  cookieHeader?: string;
  onProgress?: (status: InstagramSyncProgress) => void;
}

export interface InstagramSyncProgress {
  page: number;
  totalFetched: number;
  newAdded: number;
  running: boolean;
  done: boolean;
  stopReason?: string;
}

export interface InstagramSyncResult {
  added: number;
  totalPosts: number;
  pages: number;
  stopReason: string;
  cachePath: string;
}

// ── API helpers ──────────────────────────────────────────────────────────

function buildHeaders(csrfToken: string, cookieHeader: string): Record<string, string> {
  return {
    'user-agent': CHROME_UA,
    'x-csrftoken': csrfToken,
    'x-ig-app-id': IG_APP_ID,
    'x-ig-www-claim': 'hmac.AR3W0DThY2Mu5Fag4sW5u3RhaR3qhFD_5it3rmJm5Z3Rcidz',
    'x-requested-with': 'XMLHttpRequest',
    'x-instagram-ajax': '1',
    cookie: cookieHeader,
    accept: '*/*',
    referer: 'https://www.instagram.com/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

interface PageResult {
  posts: InstagramSavedPost[];
  nextMaxId?: string;
  hasMore: boolean;
}

function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#([\w\u00C0-\u024F]+)/g)].map(m => m[1]);
}

function extractMentions(text: string): string[] {
  return [...text.matchAll(/@([\w.]+)/g)].map(m => m[1]);
}

function resolveMediaType(item: any): InstagramMediaType {
  const mediaType = item.media_type;
  if (mediaType === 2 || item.video_versions) {
    // Check if it's a reel
    if (item.product_type === 'clips' || item.product_type === 'reels') {
      return 'reel';
    }
    return 'video';
  }
  if (mediaType === 8 || item.carousel_media) return 'carousel';
  return 'image';
}

function extractMediaItems(item: any): InstagramMediaItem[] {
  const items: InstagramMediaItem[] = [];

  // Carousel — recurse into each slide
  if (item.carousel_media && Array.isArray(item.carousel_media)) {
    for (const slide of item.carousel_media) {
      items.push(...extractMediaItems(slide));
    }
    return items;
  }

  const id = String(item.pk ?? item.id ?? '');

  // Video
  if (item.video_versions && Array.isArray(item.video_versions) && item.video_versions.length > 0) {
    // Pick highest quality video
    const best = item.video_versions.reduce((a: any, b: any) =>
      (a.width ?? 0) * (a.height ?? 0) >= (b.width ?? 0) * (b.height ?? 0) ? a : b
    );
    const imageVersions = item.image_versions2?.candidates ?? [];
    const thumbnail = imageVersions[0]?.url;

    const mediaItem: InstagramMediaItem = {
      id,
      type: 'video',
      url: thumbnail ?? best.url,
      videoUrl: best.url,
      width: best.width,
      height: best.height,
      videoDuration: item.video_duration,
    };

    // Audio info for reels
    if (item.music_metadata?.music_info?.music_asset_info) {
      const audio = item.music_metadata.music_info.music_asset_info;
      mediaItem.audioTitle = audio.title;
      mediaItem.audioArtist = audio.display_artist;
      if (audio.progressive_download_url) {
        mediaItem.audioUrl = audio.progressive_download_url;
      } else if (audio.fast_start_progressive_download_url) {
        mediaItem.audioUrl = audio.fast_start_progressive_download_url;
      }
    }

    // Also check clips_metadata for audio
    if (!mediaItem.audioUrl && item.clips_metadata?.original_sound_info) {
      const soundInfo = item.clips_metadata.original_sound_info;
      if (soundInfo.progressive_download_url) {
        mediaItem.audioUrl = soundInfo.progressive_download_url;
      }
      if (soundInfo.ig_artist) {
        mediaItem.audioArtist = soundInfo.ig_artist.username;
      }
    }

    if (!mediaItem.audioUrl && item.clips_metadata?.music_info?.music_asset_info) {
      const audio = item.clips_metadata.music_info.music_asset_info;
      mediaItem.audioTitle = audio.title;
      mediaItem.audioArtist = audio.display_artist;
      if (audio.progressive_download_url) {
        mediaItem.audioUrl = audio.progressive_download_url;
      } else if (audio.fast_start_progressive_download_url) {
        mediaItem.audioUrl = audio.fast_start_progressive_download_url;
      }
    }

    items.push(mediaItem);
    return items;
  }

  // Image
  const imageVersions = item.image_versions2?.candidates ?? [];
  if (imageVersions.length > 0) {
    const best = imageVersions[0]; // Already sorted by quality
    items.push({
      id,
      type: 'image',
      url: best.url,
      width: best.width,
      height: best.height,
    });
  }

  return items;
}

export function convertItemToPost(item: any, now: string): InstagramSavedPost | null {
  const media = item.media ?? item;
  if (!media) return null;

  const pk = String(media.pk ?? media.id ?? '');
  if (!pk) return null;

  const code = media.code ?? '';
  const caption = media.caption?.text ?? '';
  const user = media.user ?? {};

  const author: InstagramAuthorSnapshot = {
    id: String(user.pk ?? user.id ?? ''),
    username: user.username ?? '',
    fullName: user.full_name,
    profilePicUrl: user.profile_pic_url,
    isVerified: user.is_verified,
    isPrivate: user.is_private,
  };

  const mediaType = resolveMediaType(media);
  const mediaItems = extractMediaItems(media);
  const isReel = mediaType === 'reel' ||
    media.product_type === 'clips' ||
    media.product_type === 'reels';

  // Tagged users
  const taggedUsers: string[] = [];
  if (media.usertags?.in) {
    for (const tag of media.usertags.in) {
      if (tag.user?.username) taggedUsers.push(tag.user.username);
    }
  }

  // Audio info
  let audio: InstagramSavedPost['audio'];
  const musicMeta = media.music_metadata?.music_info?.music_asset_info ??
    media.clips_metadata?.music_info?.music_asset_info;
  if (musicMeta) {
    audio = {
      id: String(musicMeta.audio_cluster_id ?? musicMeta.audio_id ?? ''),
      title: musicMeta.title ?? '',
      artist: musicMeta.display_artist,
      url: musicMeta.progressive_download_url ?? musicMeta.fast_start_progressive_download_url,
    };
  }

  // Original sound for reels
  if (!audio && media.clips_metadata?.original_sound_info) {
    const soundInfo = media.clips_metadata.original_sound_info;
    audio = {
      id: String(soundInfo.audio_asset_id ?? ''),
      title: soundInfo.original_audio_title ?? 'Original audio',
      artist: soundInfo.ig_artist?.username,
      url: soundInfo.progressive_download_url,
    };
  }

  const postedAt = media.taken_at
    ? new Date(media.taken_at * 1000).toISOString()
    : null;

  return {
    id: pk,
    shortcode: code,
    mediaType,
    url: code ? `https://www.instagram.com/p/${code}/` : `https://www.instagram.com/p/${pk}/`,
    caption,
    author,
    postedAt,
    syncedAt: now,
    engagement: {
      likeCount: media.like_count,
      commentCount: media.comment_count,
      viewCount: media.view_count ?? media.video_view_count,
      playCount: media.play_count,
      shareCount: media.reshare_count,
    },
    mediaItems,
    location: media.location?.name ?? media.location?.short_name,
    hashtags: extractHashtags(caption),
    mentions: extractMentions(caption),
    accessibilityCaption: media.accessibility_caption,
    audio,
    isReel,
    taggedUsers,
  };
}

function parseSavedPostsResponse(json: any, now: string): PageResult {
  const items: any[] = json?.items ?? [];
  const posts: InstagramSavedPost[] = [];

  for (const item of items) {
    const post = convertItemToPost(item, now);
    if (post) posts.push(post);
  }

  return {
    posts,
    nextMaxId: json?.next_max_id,
    hasMore: Boolean(json?.more_available),
  };
}

async function fetchPageWithRetry(
  csrfToken: string,
  cookieHeader: string,
  nextMaxId?: string,
): Promise<PageResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 4; attempt++) {
    const url = nextMaxId
      ? `https://www.instagram.com/api/v1/feed/saved/posts/?max_id=${nextMaxId}`
      : 'https://www.instagram.com/api/v1/feed/saved/posts/';

    const response = await fetch(url, {
      headers: buildHeaders(csrfToken, cookieHeader),
    });

    if (response.status === 429) {
      const waitSec = Math.min(15 * Math.pow(2, attempt), 120);
      lastError = new Error(`Rate limited (429) on attempt ${attempt + 1}`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (response.status >= 500) {
      lastError = new Error(`Server error (${response.status}) on attempt ${attempt + 1}`);
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Instagram API returned ${response.status}.\n` +
        `Response: ${text.slice(0, 300)}\n\n` +
        (response.status === 401 || response.status === 403
          ? 'Fix: Your Instagram session may have expired. Open your browser, go to https://www.instagram.com, and make sure you are logged in. Then retry.'
          : 'This may be a temporary issue. Try again in a few minutes.'),
      );
    }

    const json = await response.json();
    return parseSavedPostsResponse(json, new Date().toISOString());
  }

  throw lastError ?? new Error('Instagram API: all retry attempts failed. Try again later.');
}

// ── Merge logic ──────────────────────────────────────────────────────────

export function mergeInstagramRecords(
  existing: InstagramSavedPost[],
  incoming: InstagramSavedPost[],
): { merged: InstagramSavedPost[]; added: number } {
  const byId = new Map(existing.map(r => [r.id, r]));
  let added = 0;
  for (const post of incoming) {
    if (!byId.has(post.id)) added += 1;
    // Incoming is fresher — merge
    const prev = byId.get(post.id);
    byId.set(post.id, prev ? { ...prev, ...post } : post);
  }
  const merged = Array.from(byId.values());
  // Sort by posted date descending
  merged.sort((a, b) => {
    const aTime = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const bTime = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return bTime - aTime;
  });
  return { merged, added };
}

// ── Main sync ────────────────────────────────────────────────────────────

export async function syncInstagramSaved(
  options: InstagramSyncOptions = {},
): Promise<InstagramSyncResult> {
  const incremental = options.incremental ?? true;
  const maxPages = options.maxPages ?? 200;
  const delayMs = options.delayMs ?? 800;
  const maxMinutes = options.maxMinutes ?? 30;
  const stalePageLimit = options.stalePageLimit ?? 3;
  const checkpointEvery = options.checkpointEvery ?? 10;

  let csrfToken: string;
  let cookieHeader: string;

  if (options.sessionId && options.csrfToken && options.dsUserId) {
    csrfToken = options.csrfToken;
    cookieHeader = options.cookieHeader ?? [
      `sessionid=${options.sessionId}`,
      `csrftoken=${options.csrfToken}`,
      `ds_user_id=${options.dsUserId}`,
    ].join('; ');
  } else {
    const config = loadChromeSessionConfig({ browserId: options.browser });
    const chromeDir = options.chromeUserDataDir ?? config.chromeUserDataDir;
    const chromeProfile = options.chromeProfileDirectory ?? config.chromeProfileDirectory;
    const cookies = extractInstagramCookies(chromeDir, chromeProfile, config.browser);
    csrfToken = cookies.csrfToken;
    cookieHeader = cookies.cookieHeader;
  }

  ensureDataDir();
  const cachePath = instagramCachePath();
  const metaPath = instagramMetaPath();
  const statePath = instagramSyncStatePath();

  let existing = await readJsonLines<InstagramSavedPost>(cachePath);
  const newestKnownId = incremental && existing.length > 0 ? existing[0]?.id : undefined;
  const previousMeta = (await pathExists(metaPath))
    ? await readJson<InstagramCacheMeta>(metaPath)
    : undefined;
  const prevState: InstagramSyncState = (await pathExists(statePath))
    ? await readJson<InstagramSyncState>(statePath)
    : { provider: 'instagram', totalRuns: 0, totalAdded: 0, lastAdded: 0, lastSeenIds: [] };

  const started = Date.now();
  let page = 0;
  let totalAdded = 0;
  let stalePages = 0;
  let nextMaxId: string | undefined;
  const allSeenIds: string[] = [];
  let stopReason = 'unknown';

  while (page < maxPages) {
    if (Date.now() - started > maxMinutes * 60_000) {
      stopReason = 'max runtime reached';
      break;
    }

    const result = await fetchPageWithRetry(csrfToken, cookieHeader, nextMaxId);
    page += 1;

    if (result.posts.length === 0 && !result.hasMore) {
      stopReason = 'end of saved posts';
      break;
    }

    const { merged, added } = mergeInstagramRecords(existing, result.posts);
    existing = merged;
    totalAdded += added;
    result.posts.forEach(p => allSeenIds.push(p.id));

    const reachedLatestStored = Boolean(newestKnownId) &&
      result.posts.some(p => p.id === newestKnownId);

    stalePages = added === 0 ? stalePages + 1 : 0;

    options.onProgress?.({
      page,
      totalFetched: allSeenIds.length,
      newAdded: totalAdded,
      running: true,
      done: false,
    });

    if (incremental && reachedLatestStored) {
      stopReason = 'caught up to newest stored post';
      break;
    }
    if (stalePages >= stalePageLimit) {
      stopReason = 'no new posts (stale)';
      break;
    }
    if (!result.hasMore || !result.nextMaxId) {
      stopReason = 'end of saved posts';
      break;
    }

    if (page % checkpointEvery === 0) await writeJsonLines(cachePath, existing);

    nextMaxId = result.nextMaxId;
    if (page < maxPages) await new Promise(r => setTimeout(r, delayMs));
  }

  if (stopReason === 'unknown') {
    stopReason = page >= maxPages ? 'max pages reached' : 'unknown';
  }

  const syncedAt = new Date().toISOString();
  await writeJsonLines(cachePath, existing);
  await writeJson(metaPath, {
    provider: 'instagram',
    schemaVersion: 1,
    lastFullSyncAt: incremental ? previousMeta?.lastFullSyncAt : syncedAt,
    lastIncrementalSyncAt: incremental ? syncedAt : previousMeta?.lastIncrementalSyncAt,
    totalSavedPosts: existing.length,
  } satisfies InstagramCacheMeta);
  await writeJson(statePath, {
    provider: 'instagram',
    lastRunAt: syncedAt,
    totalRuns: prevState.totalRuns + 1,
    totalAdded: prevState.totalAdded + totalAdded,
    lastAdded: totalAdded,
    lastSeenIds: allSeenIds.slice(-20),
    stopReason,
  } satisfies InstagramSyncState);

  options.onProgress?.({
    page,
    totalFetched: allSeenIds.length,
    newAdded: totalAdded,
    running: false,
    done: true,
    stopReason,
  });

  return {
    added: totalAdded,
    totalPosts: existing.length,
    pages: page,
    stopReason,
    cachePath,
  };
}

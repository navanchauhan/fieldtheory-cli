/**
 * Instagram SQLite database layer.
 *
 * Parallel to bookmarks-db.ts but for Instagram saved posts.
 * Separate DB file (instagram.db) with its own schema.
 */
import type { Database } from 'sql.js';
import { openDb, saveDb } from './db.js';
import { readJsonLines } from './fs.js';
import { instagramCachePath, instagramIndexPath } from './paths.js';
import type { InstagramSavedPost } from './instagram-types.js';

const SCHEMA_VERSION = 1;

// ── Types ────────────────────────────────────────────────────────────────

export interface InstagramSearchResult {
  id: string;
  url: string;
  caption: string;
  authorUsername?: string;
  authorFullName?: string;
  mediaType: string;
  postedAt?: string | null;
  score: number;
}

export interface InstagramSearchOptions {
  query: string;
  author?: string;
  limit?: number;
  before?: string;
  after?: string;
  mediaType?: string;
}

export interface InstagramListItem {
  id: string;
  shortcode: string;
  url: string;
  caption: string;
  mediaType: string;
  authorUsername?: string;
  authorFullName?: string;
  authorProfilePicUrl?: string;
  postedAt?: string | null;
  syncedAt: string;
  location?: string;
  isReel: boolean;
  mediaCount: number;
  likeCount?: number | null;
  commentCount?: number | null;
  viewCount?: number | null;
  playCount?: number | null;
  hashtags: string[];
  mentions: string[];
  audioTitle?: string;
  audioArtist?: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface InstagramListFilters {
  query?: string;
  author?: string;
  after?: string;
  before?: string;
  mediaType?: string;
  location?: string;
  reelsOnly?: boolean;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ── Schema ───────────────────────────────────────────────────────────────

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  db.run(`CREATE TABLE IF NOT EXISTS ig_posts (
    id TEXT PRIMARY KEY,
    shortcode TEXT NOT NULL,
    media_type TEXT NOT NULL,
    url TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    author_username TEXT,
    author_full_name TEXT,
    author_profile_pic_url TEXT,
    author_id TEXT,
    author_is_verified INTEGER DEFAULT 0,
    posted_at TEXT,
    synced_at TEXT NOT NULL,
    location TEXT,
    is_reel INTEGER DEFAULT 0,
    like_count INTEGER,
    comment_count INTEGER,
    view_count INTEGER,
    play_count INTEGER,
    share_count INTEGER,
    media_count INTEGER DEFAULT 0,
    media_json TEXT,
    hashtags TEXT,
    mentions TEXT,
    tagged_users TEXT,
    accessibility_caption TEXT,
    audio_id TEXT,
    audio_title TEXT,
    audio_artist TEXT,
    audio_url TEXT,
    has_video INTEGER DEFAULT 0,
    has_audio INTEGER DEFAULT 0
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_ig_author ON ig_posts(author_username)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ig_posted ON ig_posts(posted_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ig_media_type ON ig_posts(media_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ig_is_reel ON ig_posts(is_reel)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ig_location ON ig_posts(location)`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ig_posts_fts USING fts5(
    caption,
    author_username,
    author_full_name,
    location,
    hashtags,
    content=ig_posts,
    content_rowid=rowid,
    tokenize='porter unicode61'
  )`);

  db.run(`REPLACE INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}')`);
}

// ── Insert ───────────────────────────────────────────────────────────────

function insertRecord(db: Database, p: InstagramSavedPost): void {
  const hasVideo = p.mediaItems.some(m => m.type === 'video' || m.videoUrl);
  const hasAudio = Boolean(p.audio?.url) || p.mediaItems.some(m => Boolean(m.audioUrl));

  db.run(
    `INSERT OR REPLACE INTO ig_posts VALUES (${Array(31).fill('?').join(',')})`,
    [
      p.id,
      p.shortcode,
      p.mediaType,
      p.url,
      p.caption,
      p.author.username ?? null,
      p.author.fullName ?? null,
      p.author.profilePicUrl ?? null,
      p.author.id ?? null,
      p.author.isVerified ? 1 : 0,
      p.postedAt ?? null,
      p.syncedAt,
      p.location ?? null,
      p.isReel ? 1 : 0,
      p.engagement?.likeCount ?? null,
      p.engagement?.commentCount ?? null,
      p.engagement?.viewCount ?? null,
      p.engagement?.playCount ?? null,
      p.engagement?.shareCount ?? null,
      p.mediaItems.length,
      JSON.stringify(p.mediaItems),
      p.hashtags.join(','),
      p.mentions.join(','),
      p.taggedUsers.join(','),
      p.accessibilityCaption ?? null,
      p.audio?.id ?? null,
      p.audio?.title ?? null,
      p.audio?.artist ?? null,
      p.audio?.url ?? null,
      hasVideo ? 1 : 0,
      hasAudio ? 1 : 0,
    ],
  );
}

// ── Build index ──────────────────────────────────────────────────────────

export async function buildInstagramIndex(options?: { force?: boolean }): Promise<{
  dbPath: string;
  recordCount: number;
  newRecords: number;
}> {
  const cachePath = instagramCachePath();
  const dbPath = instagramIndexPath();
  const records = await readJsonLines<InstagramSavedPost>(cachePath);

  const db = await openDb(dbPath);
  try {
    if (options?.force) {
      db.run('DROP TABLE IF EXISTS ig_posts_fts');
      db.run('DROP TABLE IF EXISTS ig_posts');
      db.run('DROP TABLE IF EXISTS meta');
    }

    initSchema(db);

    const existingIds = new Set<string>();
    try {
      const rows = db.exec('SELECT id FROM ig_posts');
      for (const r of (rows[0]?.values ?? [])) existingIds.add(r[0] as string);
    } catch { /* empty */ }

    const newRecords = records.filter(r => !existingIds.has(r.id));

    if (newRecords.length > 0) {
      db.run('BEGIN TRANSACTION');
      try {
        for (const record of newRecords) insertRecord(db, record);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    }

    db.run(`INSERT INTO ig_posts_fts(ig_posts_fts) VALUES('rebuild')`);
    saveDb(db, dbPath);

    const totalRows = db.exec('SELECT COUNT(*) FROM ig_posts')[0]?.values[0]?.[0] as number;
    return { dbPath, recordCount: totalRows, newRecords: newRecords.length };
  } finally {
    db.close();
  }
}

// ── Search ───────────────────────────────────────────────────────────────

export async function searchInstagramPosts(
  options: InstagramSearchOptions,
): Promise<InstagramSearchResult[]> {
  const dbPath = instagramIndexPath();
  const db = await openDb(dbPath);
  const limit = options.limit ?? 20;

  try {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.query) {
      conditions.push(`p.rowid IN (SELECT rowid FROM ig_posts_fts WHERE ig_posts_fts MATCH ?)`);
      params.push(options.query);
    }
    if (options.author) {
      conditions.push(`p.author_username = ? COLLATE NOCASE`);
      params.push(options.author);
    }
    if (options.after) {
      conditions.push(`p.posted_at >= ?`);
      params.push(options.after);
    }
    if (options.before) {
      conditions.push(`p.posted_at <= ?`);
      params.push(options.before);
    }
    if (options.mediaType) {
      conditions.push(`p.media_type = ?`);
      params.push(options.mediaType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let sql: string;
    if (options.query) {
      sql = `
        SELECT p.id, p.url, p.caption, p.author_username, p.author_full_name,
               p.media_type, p.posted_at, bm25(ig_posts_fts, 5.0, 1.0, 1.0, 1.0, 1.0) as score
        FROM ig_posts p
        JOIN ig_posts_fts ON ig_posts_fts.rowid = p.rowid
        ${where}
        ORDER BY score ASC
        LIMIT ?
      `;
    } else {
      sql = `
        SELECT p.id, p.url, p.caption, p.author_username, p.author_full_name,
               p.media_type, p.posted_at, 0 as score
        FROM ig_posts p
        ${where}
        ORDER BY p.posted_at DESC
        LIMIT ?
      `;
    }
    params.push(limit);

    const rows = db.exec(sql, params);
    if (!rows.length) return [];

    return rows[0].values.map(row => ({
      id: row[0] as string,
      url: row[1] as string,
      caption: row[2] as string,
      authorUsername: (row[3] as string) ?? undefined,
      authorFullName: (row[4] as string) ?? undefined,
      mediaType: row[5] as string,
      postedAt: (row[6] as string) ?? null,
      score: row[7] as number,
    }));
  } finally {
    db.close();
  }
}

// ── List ─────────────────────────────────────────────────────────────────

function buildWhereClause(filters: InstagramListFilters): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.query) {
    conditions.push(`p.rowid IN (SELECT rowid FROM ig_posts_fts WHERE ig_posts_fts MATCH ?)`);
    params.push(filters.query);
  }
  if (filters.author) {
    conditions.push(`p.author_username = ? COLLATE NOCASE`);
    params.push(filters.author);
  }
  if (filters.after) {
    conditions.push(`p.posted_at >= ?`);
    params.push(filters.after);
  }
  if (filters.before) {
    conditions.push(`p.posted_at <= ?`);
    params.push(filters.before);
  }
  if (filters.mediaType) {
    conditions.push(`p.media_type = ?`);
    params.push(filters.mediaType);
  }
  if (filters.location) {
    conditions.push(`p.location LIKE ?`);
    params.push(`%${filters.location}%`);
  }
  if (filters.reelsOnly) {
    conditions.push(`p.is_reel = 1`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function mapListRow(row: unknown[]): InstagramListItem {
  return {
    id: row[0] as string,
    shortcode: row[1] as string,
    url: row[2] as string,
    caption: row[3] as string,
    mediaType: row[4] as string,
    authorUsername: (row[5] as string) ?? undefined,
    authorFullName: (row[6] as string) ?? undefined,
    authorProfilePicUrl: (row[7] as string) ?? undefined,
    postedAt: (row[8] as string) ?? null,
    syncedAt: row[9] as string,
    location: (row[10] as string) ?? undefined,
    isReel: Boolean(row[11]),
    mediaCount: Number(row[12] ?? 0),
    likeCount: row[13] as number | null,
    commentCount: row[14] as number | null,
    viewCount: row[15] as number | null,
    playCount: row[16] as number | null,
    hashtags: (row[17] as string)?.split(',').filter(Boolean) ?? [],
    mentions: (row[18] as string)?.split(',').filter(Boolean) ?? [],
    audioTitle: (row[19] as string) ?? undefined,
    audioArtist: (row[20] as string) ?? undefined,
    hasVideo: Boolean(row[21]),
    hasAudio: Boolean(row[22]),
  };
}

export async function listInstagramPosts(
  filters: InstagramListFilters = {},
): Promise<InstagramListItem[]> {
  const dbPath = instagramIndexPath();
  const db = await openDb(dbPath);
  const limit = filters.limit ?? 30;
  const offset = filters.offset ?? 0;
  const dir = filters.sort === 'asc' ? 'ASC' : 'DESC';

  try {
    const { where, params } = buildWhereClause(filters);
    const sql = `
      SELECT
        p.id, p.shortcode, p.url, p.caption, p.media_type,
        p.author_username, p.author_full_name, p.author_profile_pic_url,
        p.posted_at, p.synced_at, p.location, p.is_reel,
        p.media_count, p.like_count, p.comment_count, p.view_count, p.play_count,
        p.hashtags, p.mentions, p.audio_title, p.audio_artist,
        p.has_video, p.has_audio
      FROM ig_posts p
      ${where}
      ORDER BY COALESCE(p.posted_at, p.synced_at) ${dir}
      LIMIT ?
      OFFSET ?
    `;
    params.push(limit, offset);

    const rows = db.exec(sql, params);
    if (!rows.length) return [];
    return rows[0].values.map(row => mapListRow(row));
  } finally {
    db.close();
  }
}

// ── Get by ID ────────────────────────────────────────────────────────────

export async function getInstagramPostById(id: string): Promise<InstagramListItem | null> {
  const dbPath = instagramIndexPath();
  const db = await openDb(dbPath);

  try {
    const rows = db.exec(
      `SELECT
        p.id, p.shortcode, p.url, p.caption, p.media_type,
        p.author_username, p.author_full_name, p.author_profile_pic_url,
        p.posted_at, p.synced_at, p.location, p.is_reel,
        p.media_count, p.like_count, p.comment_count, p.view_count, p.play_count,
        p.hashtags, p.mentions, p.audio_title, p.audio_artist,
        p.has_video, p.has_audio
      FROM ig_posts p
      WHERE p.id = ? OR p.shortcode = ?
      LIMIT 1`,
      [id, id],
    );
    const row = rows[0]?.values?.[0];
    return row ? mapListRow(row) : null;
  } finally {
    db.close();
  }
}

// ── Stats ────────────────────────────────────────────────────────────────

export async function getInstagramStats(): Promise<{
  totalPosts: number;
  totalReels: number;
  totalImages: number;
  totalVideos: number;
  totalCarousels: number;
  uniqueAuthors: number;
  dateRange: { earliest: string | null; latest: string | null };
  topAuthors: { username: string; count: number }[];
  topLocations: { location: string; count: number }[];
  postsWithAudio: number;
  postsWithVideo: number;
}> {
  const dbPath = instagramIndexPath();
  const db = await openDb(dbPath);

  try {
    const total = db.exec('SELECT COUNT(*) FROM ig_posts')[0]?.values[0]?.[0] as number;
    const reels = db.exec('SELECT COUNT(*) FROM ig_posts WHERE is_reel = 1')[0]?.values[0]?.[0] as number;
    const images = db.exec("SELECT COUNT(*) FROM ig_posts WHERE media_type = 'image'")[0]?.values[0]?.[0] as number;
    const videos = db.exec("SELECT COUNT(*) FROM ig_posts WHERE media_type = 'video'")[0]?.values[0]?.[0] as number;
    const carousels = db.exec("SELECT COUNT(*) FROM ig_posts WHERE media_type = 'carousel'")[0]?.values[0]?.[0] as number;
    const authors = db.exec('SELECT COUNT(DISTINCT author_username) FROM ig_posts')[0]?.values[0]?.[0] as number;
    const range = db.exec('SELECT MIN(posted_at), MAX(posted_at) FROM ig_posts WHERE posted_at IS NOT NULL')[0]?.values[0];
    const withAudio = db.exec('SELECT COUNT(*) FROM ig_posts WHERE has_audio = 1')[0]?.values[0]?.[0] as number;
    const withVideo = db.exec('SELECT COUNT(*) FROM ig_posts WHERE has_video = 1')[0]?.values[0]?.[0] as number;

    const topAuthorsRows = db.exec(
      `SELECT author_username, COUNT(*) as c FROM ig_posts
       WHERE author_username IS NOT NULL
       GROUP BY author_username ORDER BY c DESC LIMIT 15`,
    );
    const topAuthors = (topAuthorsRows[0]?.values ?? []).map(r => ({
      username: r[0] as string,
      count: r[1] as number,
    }));

    const topLocRows = db.exec(
      `SELECT location, COUNT(*) as c FROM ig_posts
       WHERE location IS NOT NULL AND location != ''
       GROUP BY location ORDER BY c DESC LIMIT 10`,
    );
    const topLocations = (topLocRows[0]?.values ?? []).map(r => ({
      location: r[0] as string,
      count: r[1] as number,
    }));

    return {
      totalPosts: total,
      totalReels: reels,
      totalImages: images,
      totalVideos: videos,
      totalCarousels: carousels,
      uniqueAuthors: authors,
      dateRange: { earliest: (range?.[0] as string) ?? null, latest: (range?.[1] as string) ?? null },
      topAuthors,
      topLocations,
      postsWithAudio: withAudio,
      postsWithVideo: withVideo,
    };
  } finally {
    db.close();
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

export function formatInstagramSearchResults(results: InstagramSearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => {
      const author = r.authorUsername ? `@${r.authorUsername}` : 'unknown';
      const date = r.postedAt ? r.postedAt.slice(0, 10) : '?';
      const caption = r.caption.length > 140 ? r.caption.slice(0, 140) + '...' : r.caption;
      const type = r.mediaType === 'reel' ? ' [reel]' : r.mediaType === 'video' ? ' [video]' : '';
      return `${i + 1}. [${date}] ${author}${type}\n   ${caption}\n   ${r.url}`;
    })
    .join('\n\n');
}

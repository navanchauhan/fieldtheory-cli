/**
 * Instagram media downloader.
 *
 * Downloads images, videos, and audio from Instagram posts/reels to local storage.
 * Media files are stored in ~/.ft-bookmarks/instagram-media/ with a manifest
 * tracking what has been downloaded.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { instagramMediaDir, instagramMediaManifestPath } from './paths.js';
import { readJson, writeJson, pathExists } from './fs.js';
import type { InstagramSavedPost, InstagramMediaItem } from './instagram-types.js';

interface MediaManifestEntry {
  postId: string;
  mediaId: string;
  type: 'image' | 'video' | 'audio';
  localPath: string;
  sourceUrl: string;
  downloadedAt: string;
}

interface MediaManifest {
  entries: MediaManifestEntry[];
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

function getExtension(url: string, type: 'image' | 'video' | 'audio'): string {
  // Try to extract from URL
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath).split('?')[0];
  if (ext && ext.length <= 5) return ext;

  // Fallback by type
  switch (type) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'audio': return '.mp4';
  }
}

export interface MediaDownloadProgress {
  done: number;
  total: number;
  skipped: number;
  failed: number;
  currentPost?: string;
}

export interface MediaDownloadResult {
  downloaded: number;
  skipped: number;
  failed: number;
  totalSize: number;
  mediaDir: string;
}

export async function downloadInstagramMedia(
  posts: InstagramSavedPost[],
  options?: {
    onProgress?: (progress: MediaDownloadProgress) => void;
    downloadVideo?: boolean;
    downloadAudio?: boolean;
    downloadImages?: boolean;
    delayMs?: number;
  },
): Promise<MediaDownloadResult> {
  const downloadVideo = options?.downloadVideo ?? true;
  const downloadAudio = options?.downloadAudio ?? true;
  const downloadImages = options?.downloadImages ?? true;
  const delayMs = options?.delayMs ?? 200;

  const mediaRoot = instagramMediaDir();
  await mkdir(mediaRoot, { recursive: true });

  const manifestPath = instagramMediaManifestPath();
  const manifest: MediaManifest = (await pathExists(manifestPath))
    ? await readJson<MediaManifest>(manifestPath)
    : { entries: [] };

  const downloaded = new Set(manifest.entries.map(e => `${e.postId}:${e.mediaId}:${e.type}`));

  // Collect all download tasks
  interface DownloadTask {
    postId: string;
    shortcode: string;
    mediaId: string;
    type: 'image' | 'video' | 'audio';
    url: string;
  }

  const tasks: DownloadTask[] = [];

  for (const post of posts) {
    for (const media of post.mediaItems) {
      // Image
      if (downloadImages && media.url && media.type === 'image') {
        const key = `${post.id}:${media.id}:image`;
        if (!downloaded.has(key)) {
          tasks.push({ postId: post.id, shortcode: post.shortcode, mediaId: media.id, type: 'image', url: media.url });
        }
      }

      // Video
      if (downloadVideo && media.videoUrl) {
        const key = `${post.id}:${media.id}:video`;
        if (!downloaded.has(key)) {
          tasks.push({ postId: post.id, shortcode: post.shortcode, mediaId: media.id, type: 'video', url: media.videoUrl });
        }
      }

      // Audio
      if (downloadAudio && media.audioUrl) {
        const key = `${post.id}:${media.id}:audio`;
        if (!downloaded.has(key)) {
          tasks.push({ postId: post.id, shortcode: post.shortcode, mediaId: media.id, type: 'audio', url: media.audioUrl });
        }
      }
    }

    // Post-level audio (from audio field)
    if (downloadAudio && post.audio?.url) {
      const audioId = post.audio.id || 'audio';
      const key = `${post.id}:${audioId}:audio`;
      if (!downloaded.has(key)) {
        tasks.push({ postId: post.id, shortcode: post.shortcode, mediaId: audioId, type: 'audio', url: post.audio.url });
      }
    }
  }

  const total = tasks.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const task of tasks) {
    const postDir = path.join(mediaRoot, task.shortcode || task.postId);
    await mkdir(postDir, { recursive: true });

    const ext = getExtension(task.url, task.type);
    const filename = `${task.type}-${task.mediaId}${ext}`;
    const destPath = path.join(postDir, filename);

    if (await fileExists(destPath)) {
      skipped++;
      done++;
      options?.onProgress?.({ done, total, skipped, failed, currentPost: task.shortcode });
      continue;
    }

    try {
      await downloadFile(task.url, destPath);
      manifest.entries.push({
        postId: task.postId,
        mediaId: task.mediaId,
        type: task.type,
        localPath: path.relative(mediaRoot, destPath),
        sourceUrl: task.url,
        downloadedAt: new Date().toISOString(),
      });
      done++;
    } catch {
      failed++;
      done++;
    }

    options?.onProgress?.({ done, total, skipped, failed, currentPost: task.shortcode });

    // Checkpoint manifest every 50 downloads
    if (done % 50 === 0) {
      await writeJson(manifestPath, manifest);
    }

    if (done < total) await new Promise(r => setTimeout(r, delayMs));
  }

  // Final save
  await writeJson(manifestPath, manifest);

  return {
    downloaded: done - skipped - failed,
    skipped,
    failed,
    totalSize: manifest.entries.length,
    mediaDir: mediaRoot,
  };
}

import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  checkFfmpegAvailability,
  probeVideo,
  generateThumbnail,
  renderClip,
} from './server/ffmpeg.ts';
import { analyzeVideoWithGemini, validateClipTimestampsAndQuote } from './server/gemini.ts';
import {
  createSessionToken,
  verifyPasscode,
  verifySessionToken,
  revokeSessionToken,
  getOwnerStatus,
  updatePasscode,
} from './server/auth.ts';
import {
  getSupabaseStatus,
  saveProject,
  getProjects,
  saveRenderJobRecord,
  savePublishedClip,
  getPublishedClips,
  deletePublishedClip,
  SUPABASE_SCHEMA_SQL,
} from './server/supabase.ts';
import {
  initUploadSession,
  saveChunk,
  assembleUpload,
  getUploadSession,
  cancelUpload,
  cleanupStaleUploads,
  ABSOLUTE_MAX_FILE_SIZE,
} from './server/resumableUpload.ts';
import {
  getSystemResourceInfo,
  checkAvailableDiskSpace,
  enqueueJob,
  getJobStatus,
} from './server/jobQueue.ts';
import { getStorageArchitectureInfo } from './server/storage.ts';
import { VideoMetadata, RenderJob, ProjectData, PublishedClip } from './src/types/index.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Directories for media storage
const DATA_DIR = path.resolve(__dirname, 'data');
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const RENDERED_DIR = path.resolve(__dirname, 'rendered');
const THUMBNAILS_DIR = path.resolve(__dirname, 'thumbnails');
const SAMPLES_DIR = path.resolve(__dirname, 'samples');
const VIDEOS_REGISTRY_FILE = path.join(DATA_DIR, 'videos_registry.json');
const RENDER_JOBS_FILE = path.join(DATA_DIR, 'render_jobs.json');

[DATA_DIR, UPLOADS_DIR, RENDERED_DIR, THUMBNAILS_DIR, SAMPLES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure Multer storage for uploaded video files
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `video-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    // Single-shot upload limit (for files larger than this, use resumable chunked upload)
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB max for legacy single-shot POST
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video file format. Supported: MP4, MOV, WebM, MKV'));
    }
  },
});

// Persistent registries
const videosRegistry = new Map<string, VideoMetadata>();
const renderJobsRegistry = new Map<string, RenderJob>();

function loadVideosRegistry(): void {
  try {
    if (fs.existsSync(VIDEOS_REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(VIDEOS_REGISTRY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const v of data) {
          if (v && v.id) {
            videosRegistry.set(v.id, v);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not load videos registry from disk:', err);
  }
}

export function saveVideosRegistry(): void {
  try {
    const list = Array.from(videosRegistry.values());
    fs.writeFileSync(VIDEOS_REGISTRY_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save videos registry to disk:', err);
  }
}

export function loadRenderJobsRegistry(): void {
  try {
    if (fs.existsSync(RENDER_JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RENDER_JOBS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const j of data) {
          if (j && j.id) {
            renderJobsRegistry.set(j.id, j);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not load render jobs from disk:', err);
  }

  // Also check data/db.json
  try {
    const localDbPath = path.join(DATA_DIR, 'db.json');
    if (fs.existsSync(localDbPath)) {
      const db = JSON.parse(fs.readFileSync(localDbPath, 'utf-8'));
      if (Array.isArray(db.renderedClips)) {
        for (const r of db.renderedClips) {
          if (r && r.id && !renderJobsRegistry.has(r.id)) {
            renderJobsRegistry.set(r.id, r);
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not load rendered clips from db.json:', err);
  }

  // Scan RENDERED_DIR for existing completed clips
  try {
    if (fs.existsSync(RENDERED_DIR)) {
      const files = fs.readdirSync(RENDERED_DIR).filter((f) => f.endsWith('.mp4'));
      for (const file of files) {
        const fullPath = path.join(RENDERED_DIR, file);
        const match = file.match(/^(?:clip-)?(job-[0-9a-zA-Z_-]+?)(?:-[0-9]+x[0-9]+)?\.mp4$/);
        const inferredId = match ? match[1] : path.basename(file, '.mp4');
        if (!renderJobsRegistry.has(inferredId)) {
          const stat = fs.statSync(fullPath);
          renderJobsRegistry.set(inferredId, {
            id: inferredId,
            clipId: inferredId,
            title: file.replace('.mp4', ''),
            sourceVideoId: '',
            startTime: 0,
            endTime: 0,
            aspectRatio: file.includes('16x9') ? '16:9' : file.includes('1x1') ? '1:1' : '9:16',
            status: 'completed',
            progress: 100,
            outputFilename: file,
            outputPath: fullPath,
            downloadUrl: `/api/clips/download/${inferredId}`,
            fileSize: stat.size,
            duration: 0,
            createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
            completedAt: new Date(stat.mtimeMs).toISOString(),
          });
        }
      }
    }
  } catch (err) {
    console.warn('Could not scan RENDERED_DIR for existing clips:', err);
  }
}

export function saveRenderJobsRegistry(): void {
  try {
    const list = Array.from(renderJobsRegistry.values());
    fs.writeFileSync(RENDER_JOBS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save render jobs to disk:', err);
  }
}

export async function resolveRenderJob(jobId: string): Promise<RenderJob | undefined> {
  if (!jobId) return undefined;

  let job = renderJobsRegistry.get(jobId);
  if (!job) {
    loadRenderJobsRegistry();
    job = renderJobsRegistry.get(jobId);
  }

  if (job && job.outputPath && fs.existsSync(job.outputPath)) {
    return job;
  }

  // Search RENDERED_DIR for file matching jobId
  if (fs.existsSync(RENDERED_DIR)) {
    const files = fs.readdirSync(RENDERED_DIR).filter((f) => f.endsWith('.mp4'));
    const matchedFile = files.find((f) => f.includes(jobId));
    if (matchedFile) {
      const fullPath = path.join(RENDERED_DIR, matchedFile);
      const stat = fs.statSync(fullPath);
      const resolvedJob: RenderJob = job || {
        id: jobId,
        clipId: jobId,
        title: matchedFile.replace('.mp4', ''),
        sourceVideoId: '',
        startTime: 0,
        endTime: 0,
        aspectRatio: matchedFile.includes('16x9') ? '16:9' : matchedFile.includes('1x1') ? '1:1' : '9:16',
        status: 'completed',
        progress: 100,
        outputFilename: matchedFile,
        outputPath: fullPath,
        downloadUrl: `/api/clips/download/${jobId}`,
        fileSize: stat.size,
        duration: 0,
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        completedAt: new Date(stat.mtimeMs).toISOString(),
      };
      resolvedJob.outputPath = fullPath;
      resolvedJob.outputFilename = matchedFile;
      resolvedJob.fileSize = stat.size;
      resolvedJob.status = 'completed';
      resolvedJob.progress = 100;
      renderJobsRegistry.set(jobId, resolvedJob);
      saveRenderJobsRegistry();
      return resolvedJob;
    }
  }

  return job;
}

// Initial registries load
loadVideosRegistry();
loadRenderJobsRegistry();

/**
 * Resiliently resolves a video by ID, filename, or disk scan across uploads & samples
 */
export async function resolveVideo(id: string): Promise<VideoMetadata | undefined> {
  if (!id) return undefined;

  // 1. Direct registry lookup
  const registered = videosRegistry.get(id);
  if (registered && registered.filepath && fs.existsSync(registered.filepath)) {
    return registered;
  }

  // 2. Search registered items by filename or substring
  for (const v of videosRegistry.values()) {
    if (v.filename === id || v.originalName === id || (v.filepath && v.filepath.includes(id))) {
      if (fs.existsSync(v.filepath)) return v;
    }
  }

  // 3. Scan UPLOADS_DIR and SAMPLES_DIR for matching file on disk
  const searchDirs = [UPLOADS_DIR, SAMPLES_DIR];
  let foundFile: string | null = null;

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);

    // Exact filename match
    const exact = files.find(
      (f) => f === id || f === `${id}.mp4` || f === `${id}.webm` || f === `${id}.mov` || f === `${id}.mkv`
    );
    if (exact) {
      foundFile = path.join(dir, exact);
      break;
    }

    // Substring match for video IDs or upload IDs (ignore temp chunks)
    const substring = files.find((f) => f.includes(id) && !f.endsWith('.part') && !f.startsWith('.'));
    if (substring) {
      foundFile = path.join(dir, substring);
      break;
    }
  }

  // If found on disk, probe and register into cache
  if (foundFile && fs.existsSync(foundFile)) {
    try {
      const probe = await probeVideo(foundFile);
      const stat = fs.statSync(foundFile);
      const filename = path.basename(foundFile);
      const cleanName = filename.replace(/^video-[^-]+-/, '').replace(/\.[^/.]+$/, '');
      const recoveredVideo: VideoMetadata = {
        id,
        filename,
        originalName: `${cleanName}.mp4`,
        filepath: foundFile,
        url: `/api/videos/stream/${id}`,
        duration: Math.round(probe.duration * 10) / 10,
        width: probe.width,
        height: probe.height,
        aspectRatio: `${probe.width}:${probe.height}`,
        format: probe.format || 'mp4',
        size: stat.size,
        bitrate: probe.bitrate,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
        uploadedAt: stat.birthtime?.toISOString?.() || new Date().toISOString(),
      };

      videosRegistry.set(id, recoveredVideo);
      saveVideosRegistry();
      return recoveredVideo;
    } catch (err) {
      console.warn(`Could not probe auto-discovered video at ${foundFile}:`, err);
    }
  }

  return undefined;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to get auth token
function getBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7);
  }
  return undefined;
}

// -------------------------------------------------------------
// API: AUTHENTICATION
// -------------------------------------------------------------
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { passcode } = req.body;
  if (!passcode) {
    return res.status(400).json({ error: 'Passcode is required' });
  }

  if (verifyPasscode(passcode)) {
    const token = createSessionToken();
    return res.json({
      success: true,
      token,
      message: 'Owner authenticated successfully',
    });
  }

  return res.status(401).json({ error: 'Invalid owner passcode' });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (token) {
    revokeSessionToken(token);
  }
  return res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/check', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  const isValid = verifySessionToken(token);
  return res.json({ authenticated: isValid });
});

app.post('/api/auth/passcode', (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!verifySessionToken(token)) {
    return res.status(401).json({ error: 'Owner authentication required' });
  }

  const { oldPasscode, newPasscode } = req.body;
  if (!newPasscode || newPasscode.length < 6) {
    return res.status(400).json({ error: 'New passcode must be at least 6 characters' });
  }

  const updated = updatePasscode(oldPasscode, newPasscode);
  if (updated) {
    return res.json({ success: true, message: 'Passcode changed successfully' });
  }
  return res.status(400).json({ error: 'Incorrect existing passcode' });
});

// -------------------------------------------------------------
// API: SYSTEM HEALTH, RESOURCE LIMITS & STORAGE ARCHITECTURE
// -------------------------------------------------------------
app.get('/api/system/status', async (req: Request, res: Response) => {
  const ffmpegStatus = await checkFfmpegAvailability();
  const token = getBearerToken(req);
  const supabase = getSupabaseStatus();

  return res.json({
    ffmpegAvailable: ffmpegStatus.ffmpeg,
    ffprobeAvailable: ffmpegStatus.ffprobe,
    ffmpegVersion: ffmpegStatus.version,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    supabaseConnected: supabase.isConfigured,
    supabaseUrl: supabase.url,
    authenticated: verifySessionToken(token),
    activeUploadsCount: videosRegistry.size,
  });
});

app.get('/api/system/resources', async (_req: Request, res: Response) => {
  try {
    const resources = await getSystemResourceInfo();
    return res.json(resources);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/storage/info', (_req: Request, res: Response) => {
  try {
    const storageInfo = getStorageArchitectureInfo();
    return res.json(storageInfo);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/database/status', (_req: Request, res: Response) => {
  const status = getSupabaseStatus();
  return res.json({
    ...status,
    schemaSql: SUPABASE_SCHEMA_SQL,
  });
});

// -------------------------------------------------------------
// API: RESUMABLE CHUNKED UPLOAD PROTOCOL (UP TO 20 GB)
// -------------------------------------------------------------

// Initialize a new resumable upload session
app.post('/api/upload/init', async (req: Request, res: Response) => {
  try {
    const { filename, totalSize, chunkSize, mimeType } = req.body;

    if (!filename || typeof totalSize !== 'number') {
      return res.status(400).json({ error: 'filename and totalSize are required' });
    }

    const result = await initUploadSession({
      filename,
      totalSize,
      chunkSize: chunkSize || 10 * 1024 * 1024, // default 10MB chunk
      mimeType,
    });

    return res.status(201).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Upload init error:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

// Receive a chunk stream directly into disk without buffering in RAM
app.post('/api/upload/chunk', async (req: Request, res: Response) => {
  try {
    const uploadId = req.headers['x-upload-id'] as string;
    const chunkIndexStr = req.headers['x-chunk-index'] as string;
    const chunkSizeStr = req.headers['x-chunk-size'] as string;

    if (!uploadId || chunkIndexStr === undefined) {
      return res.status(400).json({ error: 'Missing x-upload-id or x-chunk-index header' });
    }

    const chunkIndex = parseInt(chunkIndexStr, 10);
    const expectedSize = parseInt(chunkSizeStr || '0', 10);

    const result = await saveChunk({
      uploadId,
      chunkIndex,
      chunkStream: req,
      expectedSize,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Query upload status to resume interrupted upload
app.get('/api/upload/status/:uploadId', (req: Request, res: Response) => {
  const { uploadId } = req.params;
  const session = getUploadSession(uploadId);

  if (!session) {
    return res.status(404).json({ error: 'Upload session not found or expired' });
  }

  return res.json({
    uploadId: session.uploadId,
    filename: session.filename,
    totalSize: session.totalSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks,
    receivedBytes: session.receivedBytes,
    status: session.status,
  });
});

// Assemble all chunks into final video file and probe with FFprobe
app.post('/api/upload/complete', async (req: Request, res: Response) => {
  let finalPath: string | null = null;
  try {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId is required', stage: 'validation' });
    }

    const session = getUploadSession(uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found', stage: 'validation' });
    }

    // Assemble file via streaming (0 RAM overhead)
    finalPath = await assembleUpload(uploadId);
    const videoId = `vid-${Date.now()}`;

    // Probe the assembled video with strict FFprobe validation
    const probe = await probeVideo(finalPath);

    // Generate thumbnail
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    const thumbSec = Math.min(5, Math.max(0.5, probe.duration * 0.05));
    await generateThumbnail(finalPath, thumbPath, thumbSec).catch(() => {});

    const stat = fs.statSync(finalPath);

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename: path.basename(finalPath),
      originalName: session.filename,
      filepath: finalPath,
      url: `/api/videos/stream/${videoId}`,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: probe.format,
      size: stat.size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    saveVideosRegistry();

    return res.status(200).json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Upload complete error:', error);
    const msg = (error as Error).message || 'Failed to complete video upload';
    let statusCode = 500;
    let failedStage = 'assembling';

    if (
      msg.includes('container') ||
      msg.includes('codec') ||
      msg.includes('duration') ||
      msg.includes('stream') ||
      msg.includes('dimensions') ||
      msg.includes('FFprobe') ||
      msg.includes('probe')
    ) {
      statusCode = 422;
      failedStage = 'validating';
    }

    // Keep finalPath preserved on disk as required
    return res.status(statusCode).json({
      error: msg,
      stage: failedStage,
      preservedFilePath: finalPath,
    });
  }
});

// Cancel and remove partially uploaded chunks
app.delete('/api/upload/cancel/:uploadId', async (req: Request, res: Response) => {
  try {
    const { uploadId } = req.params;
    await cancelUpload(uploadId);
    return res.json({ success: true, message: 'Upload cancelled and chunks cleared' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: VIDEO UPLOAD & SOURCE MANAGEMENT
// -------------------------------------------------------------
app.post('/api/videos/upload', upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const filepath = req.file.path;
    const filename = req.file.filename;
    const videoId = `vid-${Date.now()}`;

    // Probe video with ffprobe
    const probe = await probeVideo(filepath);

    // Generate thumbnail
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    const thumbSec = Math.min(2, Math.max(0.5, probe.duration * 0.1));
    await generateThumbnail(filepath, thumbPath, thumbSec);

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename,
      originalName: req.file.originalname,
      filepath,
      url: `/api/videos/stream/${videoId}`,
      duration: Math.round(probe.duration * 10) / 10,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: probe.format,
      size: req.file.size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    saveVideosRegistry();

    return res.status(201).json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Video upload error:', error);
    return res.status(500).json({
      error: `Failed to process video: ${(error as Error).message}`,
    });
  }
});

// Generate or load real demonstration sample videos
app.post('/api/videos/sample', async (req: Request, res: Response) => {
  try {
    const { sampleType = 'podcast' } = req.body;

    let title = 'Podcast Masterclass: Building Tech in 2026';
    let duration = 65; // 65 seconds long-form video

    if (sampleType === 'keynote') {
      title = 'AI Revolution Keynote: The Future of Automation';
      duration = 80;
    } else if (sampleType === 'gaming') {
      title = 'Pro Gameplay: Championship Final Climax';
      duration = 50;
    }

    // 1. Check if a valid pre-generated sample file already exists in SAMPLES_DIR to avoid expensive 35s re-encodes
    if (fs.existsSync(SAMPLES_DIR)) {
      const existingFiles = fs.readdirSync(SAMPLES_DIR);
      const matched = existingFiles.find((f) => f.startsWith(`sample-${sampleType}`) && f.endsWith('.mp4'));
      if (matched) {
        const existingPath = path.join(SAMPLES_DIR, matched);
        const stat = fs.statSync(existingPath);
        if (stat.size > 100000) {
          const probe = await probeVideo(existingPath);
          const videoId = path.basename(matched, '.mp4');
          const thumbFilename = `thumb-${videoId}.jpg`;
          const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
          if (!fs.existsSync(thumbPath)) {
            await generateThumbnail(existingPath, thumbPath, 2).catch(() => {});
          }

          const cachedVideo: VideoMetadata = {
            id: videoId,
            filename: matched,
            originalName: `${title}.mp4`,
            filepath: existingPath,
            url: `/api/videos/stream/${videoId}`,
            duration: Math.round(probe.duration * 10) / 10,
            width: probe.width,
            height: probe.height,
            aspectRatio: `${probe.width}:${probe.height}`,
            format: 'mp4',
            size: stat.size,
            bitrate: probe.bitrate,
            fps: probe.fps,
            hasAudio: true,
            uploadedAt: new Date().toISOString(),
          };

          videosRegistry.set(videoId, cachedVideo);
          saveVideosRegistry();

          return res.json({
            success: true,
            video: cachedVideo,
            thumbnailUrl: `/api/thumbnails/${videoId}`,
          });
        }
      }
    }

    // 2. Generate video using FFmpeg if not yet present
    const videoId = `sample-${sampleType}-${Date.now()}`;
    const filename = `${videoId}.mp4`;
    const filepath = path.join(SAMPLES_DIR, filename);

    const ffmpegCmd = [
      '-f', 'lavfi',
      '-i', `testsrc=duration=${duration}:size=1920x1080:rate=30`,
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${duration}`,
      '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='ClipGenius Source\\: ${title}':x=80:y=80:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Time\\: %{pts\\:hms}':x=80:y=160:fontsize=36:fontcolor=yellow:box=1:boxcolor=black@0.6`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      filepath,
    ];

    const { spawn } = await import('child_process');
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ffmpegCmd);
      child.on('close', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`Sample generation exited with code ${code}`));
      });
      child.on('error', reject);
    });

    const probe = await probeVideo(filepath);
    const thumbFilename = `thumb-${videoId}.jpg`;
    const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);
    await generateThumbnail(filepath, thumbPath, 2).catch(() => {});

    const videoMeta: VideoMetadata = {
      id: videoId,
      filename,
      originalName: `${title}.mp4`,
      filepath,
      url: `/api/videos/stream/${videoId}`,
      duration: Math.round(probe.duration * 10) / 10,
      width: probe.width,
      height: probe.height,
      aspectRatio: `${probe.width}:${probe.height}`,
      format: 'mp4',
      size: fs.statSync(filepath).size,
      bitrate: probe.bitrate,
      fps: probe.fps,
      hasAudio: true,
      uploadedAt: new Date().toISOString(),
    };

    videosRegistry.set(videoId, videoMeta);
    saveVideosRegistry();

    return res.json({
      success: true,
      video: videoMeta,
      thumbnailUrl: `/api/thumbnails/${videoId}`,
    });
  } catch (error) {
    console.error('Failed to generate sample video:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Stream video with HTTP 206 partial content support for scrubbing
app.get('/api/videos/stream/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const video = await resolveVideo(id);

  if (!video || !video.filepath || !fs.existsSync(video.filepath)) {
    return res.status(404).json({ error: 'Video stream not found' });
  }

  const filepath = video.filepath;
  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const ext = path.extname(filepath).toLowerCase();
  let contentType = 'video/mp4';
  if (ext === '.webm') contentType = 'video/webm';
  else if (ext === '.mov') contentType = 'video/quicktime';
  else if (ext === '.mkv') contentType = 'video/x-matroska';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filepath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    fs.createReadStream(filepath).pipe(res);
  }
});

// Serve thumbnail images (supports ?time= or ?t= for specific clip timestamp frames)
app.get('/api/thumbnails/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const timeQuery = req.query.time || req.query.t;
  const timeSec = timeQuery !== undefined ? Math.max(0, parseFloat(timeQuery as string) || 0) : null;

  // Cache thumbnail per timestamp or default
  const thumbFilename = timeSec !== null
    ? `thumb-${id}-t${Math.round(timeSec * 10) / 10}.jpg`
    : `thumb-${id}.jpg`;
  const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

  if (fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  }

  // Attempt to generate thumbnail dynamically if video exists
  const video = await resolveVideo(id);
  if (video && fs.existsSync(video.filepath)) {
    try {
      const seekTime = timeSec !== null
        ? Math.min(timeSec, Math.max(0, (video.duration || 10) - 0.5))
        : Math.min(2, Math.max(0, (video.duration || 10) / 2));
      await generateThumbnail(video.filepath, thumbPath, seekTime);
      if (fs.existsSync(thumbPath)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return fs.createReadStream(thumbPath).pipe(res);
      }
    } catch (err) {
      console.warn(`Failed to generate thumbnail for ${id} at time ${timeSec}:`, err);
    }
  }

  // Fallback to default thumbnail if timestamp-specific failed
  const defaultThumb = path.join(THUMBNAILS_DIR, `thumb-${id}.jpg`);
  if (fs.existsSync(defaultThumb)) {
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(defaultThumb).pipe(res);
  }

  return res.status(404).json({ error: 'Thumbnail not found' });
});

// -------------------------------------------------------------
// API: AI CLIP ANALYSIS (GEMINI 3.8 FLASH)
// -------------------------------------------------------------
app.post('/api/ai/analyze', async (req: Request, res: Response) => {
  try {
    const {
      videoId,
      clipCount = 3,
      clipStyle = 'viral_shorts',
      customPrompt,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName,
      chunkOffsetSeconds,
      previouslySelectedClips,
    } = req.body;

    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required for AI analysis' });
    }

    const video = await resolveVideo(videoId);
    if (!video) {
      return res.status(404).json({ error: `Source video "${videoId}" not found on server` });
    }

    const clips = await analyzeVideoWithGemini({
      duration: video.duration,
      filename: video.originalName,
      clipCount: Number(clipCount) || 3,
      clipStyle,
      customPrompt,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName: chunkName || 'chunk_01',
      chunkOffsetSeconds: Number(chunkOffsetSeconds) || 0,
      previouslySelectedClips: Array.isArray(previouslySelectedClips) ? previouslySelectedClips : [],
    });

    return res.json({
      success: true,
      clips,
      sourceVideo: video,
    });
  } catch (error) {
    console.error('AI Analysis failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Endpoint to independently validate clip timestamps and quote before render/publish
app.post('/api/clips/validate', (req: Request, res: Response) => {
  try {
    const { clip, videoDuration, transcript } = req.body;
    if (!clip || typeof videoDuration !== 'number') {
      return res.status(400).json({ error: 'Missing clip object or videoDuration' });
    }

    const validation = validateClipTimestampsAndQuote(clip, videoDuration, transcript);
    return res.json(validation);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: FFMPEG REAL VIDEO RENDERING ENGINE
// -------------------------------------------------------------
app.post('/api/clips/render', async (req: Request, res: Response) => {
  try {
    const {
      sourceVideoId,
      clipId,
      title,
      startTime,
      endTime,
      aspectRatio = '9:16',
    } = req.body;

    const video = await resolveVideo(sourceVideoId);
    if (!video || !fs.existsSync(video.filepath)) {
      return res.status(404).json({ error: 'Source video not found on disk' });
    }

    const jobId = `job-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const outputFilename = `clip-${jobId}-${aspectRatio.replace(':', 'x')}.mp4`;
    const outputPath = path.join(RENDERED_DIR, outputFilename);

    const safeStart = Math.max(0, parseFloat(startTime) || 0);
    const safeEnd = Math.min(video.duration, parseFloat(endTime) || safeStart + 30);
    const targetDuration = Math.max(0.5, safeEnd - safeStart);

    const renderJob: RenderJob = {
      id: jobId,
      clipId: clipId || jobId,
      title: title || `Viral Clip (${aspectRatio})`,
      sourceVideoId,
      startTime: safeStart,
      endTime: safeEnd,
      aspectRatio: (aspectRatio as '9:16' | '1:1' | '16:9') || '9:16',
      status: 'rendering',
      progress: 0,
      outputFilename,
      outputPath,
      downloadUrl: `/api/clips/download/${jobId}`,
      duration: Math.round(targetDuration * 10) / 10,
      createdAt: new Date().toISOString(),
    };

    renderJobsRegistry.set(jobId, renderJob);

    // Enqueue render task with concurrency & resource protection
    enqueueJob({
      id: jobId,
      type: 'render',
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      task: async () => {
        const currentJob = renderJobsRegistry.get(jobId);
        if (currentJob) {
          currentJob.status = 'rendering';
        }

        try {
          await renderClip({
            sourcePath: video.filepath,
            outputPath,
            startTime: safeStart,
            endTime: safeEnd,
            aspectRatio: renderJob.aspectRatio,
            onProgress: (percent) => {
              const job = renderJobsRegistry.get(jobId);
              if (job) {
                job.progress = percent;
              }
            },
          });

          const job = renderJobsRegistry.get(jobId);
          if (job) {
            job.status = 'completed';
            job.progress = 100;
            job.completedAt = new Date().toISOString();
            if (fs.existsSync(outputPath)) {
              job.fileSize = fs.statSync(outputPath).size;
            }
            saveRenderJobsRegistry();
            await saveRenderJobRecord(job);
          }
        } catch (err) {
          console.error('Render error:', err);
          const job = renderJobsRegistry.get(jobId);
          if (job) {
            job.status = 'failed';
            job.error = (err as Error).message;
            saveRenderJobsRegistry();
          }
          throw err;
        }
      },
    });

    return res.status(202).json({
      success: true,
      job: renderJob,
    });
  } catch (error) {
    console.error('Rendering dispatch failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// List all render jobs in queue/history
app.get('/api/clips/renders', async (_req: Request, res: Response) => {
  loadRenderJobsRegistry();
  const jobs = Array.from(renderJobsRegistry.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );
  return res.json({ jobs });
});

// Check status of a render job
app.get('/api/clips/status/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = await resolveRenderJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  return res.json({ job });
});

// Direct Download rendered MP4 clip for Phone & Desktop
app.get('/api/clips/download/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = await resolveRenderJob(jobId);

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Rendered clip not found or still processing on server' });
  }

  const stat = fs.statSync(job.outputPath);
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}${mm}${dd}`;
  const cleanTitle = (job.title || 'Clip')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 32);
  const safeAspect = (job.aspectRatio || '9:16').replace(':', 'x');
  const filename = `ClipGenius_Final_${dateStr}_${cleanTitle}_${safeAspect}.mp4`;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000');

  const stream = fs.createReadStream(job.outputPath);
  stream.on('error', (err) => {
    console.error('Download stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream video file' });
    }
  });
  stream.pipe(res);
});

// Stream rendered MP4 clip for in-browser playback
app.get('/api/clips/stream/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = await resolveRenderJob(jobId);

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).send('Rendered clip not found');
  }

  const stat = fs.statSync(job.outputPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(job.outputPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    fs.createReadStream(job.outputPath).pipe(res);
  }
});

// Delete rendered clip from server storage (does NOT affect user downloads)
app.delete('/api/clips/render/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = await resolveRenderJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  // Remove the server-side rendered file from disk
  if (job.outputPath && fs.existsSync(job.outputPath)) {
    try {
      fs.unlinkSync(job.outputPath);
      console.log(`Deleted server rendered file: ${job.outputPath}`);
    } catch (err) {
      console.warn(`Could not delete rendered file ${job.outputPath}:`, err);
    }
  }

  // Remove from memory registry and persist
  renderJobsRegistry.delete(jobId);
  saveRenderJobsRegistry();

  // Also remove from local db.json
  try {
    const localDbPath = path.join(DATA_DIR, 'db.json');
    if (fs.existsSync(localDbPath)) {
      const db = JSON.parse(fs.readFileSync(localDbPath, 'utf-8'));
      if (Array.isArray(db.renderedClips)) {
        db.renderedClips = db.renderedClips.filter((r: any) => r.id !== jobId);
        fs.writeFileSync(localDbPath, JSON.stringify(db, null, 2), 'utf-8');
      }
    }
  } catch (err) {
    console.warn('Could not update db.json after render deletion:', err);
  }

  return res.json({
    success: true,
    jobId,
    message: 'Server-side render removed from ClipGenius AI storage. Any copies previously downloaded to your phone or computer remain completely safe and intact in your device Downloads folder.',
  });
});

// -------------------------------------------------------------
// API: INDIVIDUAL CLIP PUBLISHING WORKFLOW & SUPABASE SYNC
// -------------------------------------------------------------

// Publish an individual reviewed clip
app.post('/api/clips/publish', async (req: Request, res: Response) => {
  try {
    const {
      clipId,
      projectId,
      title,
      hook,
      platform = 'tiktok',
      postCaption,
      hashtags = [],
      videoUrl,
      downloadUrl,
      renderJobId,
      scheduledFor,
    } = req.body;

    if (!clipId || !title || !hook) {
      return res.status(400).json({ error: 'Missing required clip publishing fields (clipId, title, hook)' });
    }

    const publishedRecord: PublishedClip = {
      id: `pub-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      clipId,
      projectId: projectId || undefined,
      title,
      hook,
      platform: platform as any,
      postCaption: postCaption || `${title}\n\n"${hook}"\n\n${(hashtags || []).join(' ')}`,
      hashtags: Array.isArray(hashtags) ? hashtags : ['#viral', '#shorts', '#trending'],
      videoUrl: videoUrl || (renderJobId ? `/api/clips/stream/${renderJobId}` : undefined),
      downloadUrl: downloadUrl || (renderJobId ? `/api/clips/download/${renderJobId}` : undefined),
      renderJobId: renderJobId || undefined,
      publishedAt: new Date().toISOString(),
      status: scheduledFor ? 'scheduled' : 'published',
      scheduledFor: scheduledFor || undefined,
    };

    const saved = await savePublishedClip(publishedRecord);

    return res.status(201).json({
      success: true,
      publishedClip: saved,
      message: `Clip "${title}" successfully published for ${platform.toUpperCase()}`,
    });
  } catch (error) {
    console.error('Failed to publish clip:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Retrieve all individually published clips
app.get('/api/clips/published', async (_req: Request, res: Response) => {
  try {
    const published = await getPublishedClips();
    return res.json({ published });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Remove/unpublish a published clip record
app.delete('/api/clips/publish/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await deletePublishedClip(id);
    return res.json({ success: true, message: 'Published clip record removed' });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API: PROJECTS STORAGE & SUPABASE SYNC
// -------------------------------------------------------------
app.get('/api/projects', async (_req: Request, res: Response) => {
  try {
    const projects = await getProjects();
    return res.json({ projects });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const projectData = req.body as ProjectData;
    if (!projectData || !projectData.id) {
      return res.status(400).json({ error: 'Invalid project data' });
    }

    const saved = await saveProject(projectData);
    return res.json({ success: true, project: saved });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// -------------------------------------------------------------
// API 404 CATCH-ALL & ERROR HANDLER
// Ensures any unmatched /api/* route returns JSON instead of falling through to Vite's index.html
// -------------------------------------------------------------
app.all('/api/*', (req: Request, res: Response) => {
  return res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

app.use('/api', (err: any, _req: Request, res: Response, _next: any) => {
  console.error('API Error handler caught:', err);
  return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// -------------------------------------------------------------
// VITE DEV SERVER OR PRODUCTION STATIC SERVING
// -------------------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ClipGenius AI] Full-Stack server running on port ${PORT}`);
    console.log(`[ClipGenius AI] Mode: ${isProd ? 'Production' : 'Development'}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});

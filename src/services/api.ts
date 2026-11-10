import {
  VideoMetadata,
  ClipSuggestion,
  RenderJob,
  ProjectData,
  SystemStatus,
  PublishedClip,
} from '../types/index.ts';
import { getSupabaseClient } from './supabaseClient.ts';

const TOKEN_KEY = 'clipgenius_owner_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getAuthHeaders(): HeadersInit {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Safe native fetch wrapper: invokes native browser fetch without overriding global properties
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchFn = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : globalThis.fetch;
  return fetchFn(input, init);
}

// Safely parses JSON responses, gracefully handling HTML error responses or network faults
async function safeJsonResponse<T = any>(res: Response, fallbackError: string): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    const cleanText = text.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
    const preview = cleanText.slice(0, 100) || res.statusText || 'Unknown server response';
    throw new Error(
      !res.ok
        ? `Server error (${res.status}): ${preview}`
        : `Unexpected non-JSON response from server (${res.status})`
    );
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || fallbackError || `Request failed with HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  // System Health
  async getSystemStatus(): Promise<SystemStatus> {
    const token = getStoredToken();
    const res = await safeFetch('/api/system/status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return safeJsonResponse<SystemStatus>(res, 'Failed to fetch system status');
  },

  // Owner Auth
  async loginOwner(passcode: string): Promise<{ success: boolean; token: string }> {
    const res = await safeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    const data = await safeJsonResponse<{ success: boolean; token: string; error?: string }>(res, 'Login failed');
    setStoredToken(data.token);
    return data;
  },

  async logoutOwner(): Promise<void> {
    const token = getStoredToken();
    if (token) {
      await safeFetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearStoredToken();
  },

  async checkAuth(): Promise<boolean> {
    const token = getStoredToken();
    if (!token) return false;
    try {
      const res = await safeFetch('/api/auth/check', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await safeJsonResponse<{ authenticated: boolean }>(res, 'Auth check failed');
      return Boolean(data.authenticated);
    } catch {
      return false;
    }
  },

  async changePasscode(oldPasscode: string, newPasscode: string): Promise<void> {
    const res = await safeFetch('/api/auth/passcode', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ oldPasscode, newPasscode }),
    });
    await safeJsonResponse(res, 'Failed to update passcode');
  },

  // Video Upload
  async uploadVideo(file: File): Promise<{ video: VideoMetadata; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('video', file);

    const token = getStoredToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await safeFetch('/api/videos/upload', {
      method: 'POST',
      headers,
      body: formData,
    });

    return safeJsonResponse<{ video: VideoMetadata; thumbnailUrl: string }>(res, 'Failed to upload video');
  },

  // Load Demonstration Sample Video
  async loadSampleVideo(sampleType: 'podcast' | 'keynote' | 'gaming' = 'podcast'): Promise<{
    video: VideoMetadata;
    thumbnailUrl: string;
  }> {
    const res = await safeFetch('/api/videos/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleType }),
    });

    return safeJsonResponse<{ video: VideoMetadata; thumbnailUrl: string }>(res, 'Failed to load sample video');
  },

  // AI Clip Analysis
  async analyzeVideo(params: {
    videoId: string;
    clipCount?: number;
    clipStyle?: string;
    customPrompt?: string;
    transcript?: string;
    videoCategory?: string;
    targetAudience?: string;
    targetPlatforms?: string[];
    chunkName?: string;
    chunkOffsetSeconds?: number;
    previouslySelectedClips?: ClipSuggestion[];
  }): Promise<{ clips: ClipSuggestion[]; sourceVideo: VideoMetadata }> {
    const res = await safeFetch('/api/ai/analyze', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    return safeJsonResponse<{ clips: ClipSuggestion[]; sourceVideo: VideoMetadata }>(res, 'AI analysis failed');
  },

  // FFmpeg Clip Rendering
  async renderClip(params: {
    sourceVideoId: string;
    clipId: string;
    title: string;
    startTime: number;
    endTime: number;
    aspectRatio: '9:16' | '1:1' | '16:9';
  }): Promise<RenderJob> {
    const res = await safeFetch('/api/clips/render', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    const data = await safeJsonResponse<{ job: RenderJob }>(res, 'Failed to start render');
    return data.job;
  },

  // Check Render Job Status
  async getRenderJobStatus(jobId: string): Promise<RenderJob> {
    const res = await safeFetch(`/api/clips/status/${jobId}`);
    const data = await safeJsonResponse<{ job: RenderJob }>(res, 'Job not found');
    return data.job;
  },

  // List all render jobs from server
  async getRenderJobs(): Promise<RenderJob[]> {
    const res = await safeFetch('/api/clips/renders');
    const data = await safeJsonResponse<{ jobs: RenderJob[] }>(res, 'Failed to fetch render jobs');
    return data.jobs || [];
  },

  // Delete rendered clip from server storage
  async deleteRenderJob(jobId: string): Promise<{ success: boolean; message: string }> {
    const res = await safeFetch(`/api/clips/render/${jobId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return safeJsonResponse<{ success: boolean; message: string }>(res, 'Failed to delete render job');
  },

  // Projects & Supabase
  async getProjects(): Promise<ProjectData[]> {
    const res = await safeFetch('/api/projects');
    const data = await safeJsonResponse<{ projects: ProjectData[] }>(res, 'Failed to load projects');
    return data.projects || [];
  },

  async saveProject(project: ProjectData): Promise<ProjectData> {
    const res = await safeFetch('/api/projects', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(project),
    });
    const data = await safeJsonResponse<{ project: ProjectData }>(res, 'Failed to save project');
    return data.project;
  },

  async getDatabaseStatus(): Promise<{
    isConfigured: boolean;
    url: string;
    hasServiceKey: boolean;
    schemaSql: string;
  }> {
    const res = await safeFetch('/api/database/status');
    return safeJsonResponse(res, 'Failed to fetch database status');
  },

  // Resource Management & Storage
  async getSystemResources(): Promise<import('../types/index.ts').SystemResourceInfo> {
    const res = await safeFetch('/api/system/resources');
    return safeJsonResponse<import('../types/index.ts').SystemResourceInfo>(res, 'Failed to fetch system resources');
  },

  async getStorageInfo(): Promise<import('../types/index.ts').StorageArchitectureInfo> {
    const res = await safeFetch('/api/storage/info');
    return safeJsonResponse<import('../types/index.ts').StorageArchitectureInfo>(res, 'Failed to fetch storage info');
  },

  async getUploadStatus(uploadId: string): Promise<import('../types/index.ts').ResumableUploadSession> {
    const res = await safeFetch(`/api/upload/status/${uploadId}`);
    return safeJsonResponse<import('../types/index.ts').ResumableUploadSession>(res, 'Failed to fetch upload status');
  },

  async cancelUpload(uploadId: string): Promise<void> {
    await safeFetch(`/api/upload/cancel/${uploadId}`, { method: 'DELETE' });
  },

  // Validation Check
  async validateClip(params: {
    clip: Partial<ClipSuggestion>;
    videoDuration: number;
    transcript?: string;
  }): Promise<{ isValid: boolean; errors: string[] }> {
    const res = await safeFetch('/api/clips/validate', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });
    return safeJsonResponse<{ isValid: boolean; errors: string[] }>(res, 'Validation check failed');
  },

  // Individual Clip Publishing
  async publishClip(payload: {
    clipId: string;
    projectId?: string;
    title: string;
    hook: string;
    platform: 'tiktok' | 'reels' | 'shorts' | 'facebook' | 'all';
    postCaption?: string;
    hashtags?: string[];
    videoUrl?: string;
    downloadUrl?: string;
    renderJobId?: string;
    scheduledFor?: string;
  }): Promise<{ success: boolean; publishedClip: PublishedClip; message: string }> {
    const res = await safeFetch('/api/clips/publish', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    return safeJsonResponse<{ success: boolean; publishedClip: PublishedClip; message: string }>(res, 'Publishing failed');
  },

  async getPublishedClips(): Promise<PublishedClip[]> {
    const res = await safeFetch('/api/clips/published');
    const data = await safeJsonResponse<{ published: PublishedClip[] }>(res, 'Failed to load published clips');
    return data.published || [];
  },

  async deletePublishedClip(id: string): Promise<void> {
    const res = await safeFetch(`/api/clips/publish/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    await safeJsonResponse(res, 'Failed to unpublish clip');
  },

  // Client-side Supabase instance (configured with non-mutating native fetch wrapper)
  getClientSupabase() {
    return getSupabaseClient();
  },
};



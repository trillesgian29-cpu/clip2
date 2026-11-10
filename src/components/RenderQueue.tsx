import React, { useState } from 'react';
import {
  Download,
  Smartphone,
  Film,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Layers,
  Trash2,
  ShieldAlert,
  HardDrive,
  Info,
} from 'lucide-react';
import { RenderJob } from '../types/index.ts';

interface RenderQueueProps {
  jobs: RenderJob[];
  onClearJob?: (jobId: string) => Promise<void> | void;
}

export const RenderQueue: React.FC<RenderQueueProps> = ({ jobs, onClearJob }) => {
  const [downloadingJobId, setDownloadingJobId] = useState<string | null>(null);
  const [downloadSuccessJobId, setDownloadSuccessJobId] = useState<string | null>(null);
  const [copiedLinkJobId, setCopiedLinkJobId] = useState<string | null>(null);

  // Deletion Confirmation Dialog State
  const [jobToDelete, setJobToDelete] = useState<RenderJob | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-8 text-center">
        <Film className="mx-auto h-10 w-10 text-neutral-600 mb-3" />
        <h4 className="text-sm font-semibold text-neutral-300">No Render Jobs in Queue</h4>
        <p className="mt-1 text-xs text-neutral-500 max-w-sm mx-auto">
          Select any AI-generated clip and click "Render" to trigger real server-side FFmpeg rendering and download individual MP4 clips directly to your phone or PC.
        </p>
      </div>
    );
  }

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const getCleanFilename = (job: RenderJob) => {
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
    return `ClipGenius_Final_${dateStr}_${cleanTitle}_${safeAspect}.mp4`;
  };

  const handleDownload = (job: RenderJob) => {
    setDownloadingJobId(job.id);
    const downloadUrl = `/api/clips/download/${job.id}`;
    const filename = getCleanFilename(job);

    try {
      // Create hidden link to initiate browser native download with attachment headers
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', filename);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Indicate browser has initiated the download stream
      setDownloadSuccessJobId(job.id);
      setTimeout(() => {
        setDownloadingJobId(null);
      }, 1500);
      setTimeout(() => {
        setDownloadSuccessJobId(null);
      }, 5000);
    } catch (err) {
      console.error('Download initiation error:', err);
      setDownloadingJobId(null);
      // Fallback: window navigation
      window.location.href = downloadUrl;
    }
  };

  const handleCopyLink = (job: RenderJob) => {
    const absoluteUrl = `${window.location.origin}/api/clips/download/${job.id}`;
    navigator.clipboard.writeText(absoluteUrl).then(() => {
      setCopiedLinkJobId(job.id);
      setTimeout(() => setCopiedLinkJobId(null), 2500);
    });
  };

  const confirmDelete = async () => {
    if (!jobToDelete || !onClearJob) return;
    setIsDeleting(true);
    try {
      await onClearJob(jobToDelete.id);
      setJobToDelete(null);
    } catch (err) {
      console.error('Error deleting render job:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Queue Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-violet-400" />
          <h3 className="text-sm font-bold text-white">FFmpeg Rendered MP4 Clips</h3>
          <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] font-bold text-violet-300">
            {jobs.length} {jobs.length === 1 ? 'Clip' : 'Clips'}
          </span>
        </div>
        <span className="text-[11px] text-neutral-400 flex items-center gap-1.5">
          <Smartphone className="h-3.5 w-3.5 text-emerald-400" />
          Direct Phone & Desktop Native Downloads
        </span>
      </div>

      {/* Grid of Render Jobs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {jobs.map((job) => {
          const isRendering = job.status === 'rendering' || job.status === 'queued';
          const isCompleted = job.status === 'completed';
          const isFailed = job.status === 'failed';
          const isDownloadingThis = downloadingJobId === job.id;
          const isDownloadSuccessThis = downloadSuccessJobId === job.id;
          const isCopiedThis = copiedLinkJobId === job.id;

          return (
            <div
              key={job.id}
              className={`rounded-2xl border p-4 sm:p-5 flex flex-col justify-between transition ${
                isCompleted
                  ? 'border-emerald-500/40 bg-neutral-900/90 shadow-xl shadow-emerald-500/5'
                  : isRendering
                  ? 'border-violet-500/50 bg-neutral-900/80'
                  : 'border-red-500/40 bg-neutral-900/80'
              }`}
            >
              <div>
                {/* Title & Badge */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] font-bold text-neutral-300 border border-neutral-700">
                        {job.aspectRatio} Aspect
                      </span>
                      <span className="text-xs font-mono text-neutral-400">
                        {job.duration ? `${job.duration.toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <h4 className="mt-1.5 text-sm font-bold text-white leading-snug">
                      {job.title}
                    </h4>
                  </div>

                  {/* Status Indicator */}
                  <div>
                    {isRendering && (
                      <div className="flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300 border border-violet-500/30">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Rendering ({job.progress}%)</span>
                      </div>
                    )}
                    {isCompleted && (
                      <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 border border-emerald-500/30">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Ready</span>
                      </div>
                    )}
                    {isFailed && (
                      <div className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 border border-red-500/30">
                        <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                        <span>Failed</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Real-time Progress Bar */}
                {isRendering && (
                  <div className="mt-4 space-y-1.5">
                    <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-300"
                        style={{ width: `${Math.max(5, job.progress)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-neutral-400">
                      <span>Encoding vertical MP4 frames with FFmpeg...</span>
                      <span className="font-mono">{job.progress}%</span>
                    </div>
                  </div>
                )}

                {/* Error message */}
                {isFailed && job.error && (
                  <div className="mt-3 rounded-lg bg-red-950/40 border border-red-500/30 p-2.5 text-xs text-red-300">
                    {job.error}
                  </div>
                )}

                {/* Playable Video Preview for completed rendered clip */}
                {isCompleted && (
                  <div className="mt-4 overflow-hidden rounded-xl bg-black border border-neutral-800 relative group">
                    <video
                      src={`/api/clips/stream/${job.id}`}
                      controls
                      playsInline
                      preload="metadata"
                      className="w-full max-h-56 object-contain mx-auto"
                    />
                  </div>
                )}

                {/* Download Status Toast / Info */}
                {isDownloadSuccessThis && (
                  <div className="mt-3 rounded-xl bg-emerald-950/60 border border-emerald-500/40 p-2.5 text-xs text-emerald-200 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                    <span>Download started! Check your phone or browser Downloads folder.</span>
                  </div>
                )}
              </div>

              {/* Actions Footer */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-neutral-800/80">
                <span className="text-xs font-mono text-neutral-400">
                  {job.fileSize ? formatFileSize(job.fileSize) : 'MP4 File'}
                </span>

                <div className="flex items-center gap-1.5">
                  {isCompleted && (
                    <>
                      {/* Direct Download to Phone / PC Button */}
                      <button
                        type="button"
                        onClick={() => handleDownload(job)}
                        disabled={isDownloadingThis}
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-2 text-xs font-bold text-white shadow-md shadow-emerald-600/20 hover:from-emerald-500 hover:to-teal-500 transition disabled:opacity-50"
                        title="Download MP4 video directly to device storage"
                      >
                        {isDownloadingThis ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                        <span>{isDownloadingThis ? 'Starting...' : 'Download MP4'}</span>
                      </button>

                      {/* Copy Direct Link (Mobile helper) */}
                      <button
                        type="button"
                        onClick={() => handleCopyLink(job)}
                        className="flex items-center gap-1 rounded-xl border border-neutral-700 bg-neutral-800 px-2.5 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-700 hover:text-white transition"
                        title="Copy direct download link (useful for mobile Chrome/download managers)"
                      >
                        {isCopiedThis ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span className="text-emerald-300 text-[11px]">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            <span className="text-[11px]">Copy Link</span>
                          </>
                        )}
                      </button>
                    </>
                  )}

                  {/* Safe Deletion Trigger */}
                  {onClearJob && (
                    <button
                      type="button"
                      onClick={() => setJobToDelete(job)}
                      className="rounded-xl p-2 text-neutral-500 hover:text-red-400 hover:bg-red-950/20 transition"
                      title="Delete render from ClipGenius AI storage"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ============================================================ */}
      {/* INDEPENDENT RENDER DELETION CONFIRMATION DIALOG              */}
      {/* ============================================================ */}
      {jobToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  Delete from ClipGenius AI?
                </h3>
                <p className="mt-1 text-xs text-neutral-400">
                  Are you sure you want to remove <strong className="text-white">"{jobToDelete.title}"</strong> from the ClipGenius AI cloud storage?
                </p>
              </div>
            </div>

            {/* Crucial Independence Notice */}
            <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3.5 text-xs text-emerald-200 space-y-1.5">
              <div className="flex items-center gap-1.5 font-bold text-emerald-300">
                <Smartphone className="h-4 w-4" />
                <span>Your Phone Downloads Remain 100% Safe</span>
              </div>
              <p className="text-[11px] leading-relaxed text-neutral-300">
                Deleting this item only frees up server disk space in ClipGenius AI. Any copies you already downloaded to your phone, computer, or gallery will <strong className="text-white">never be deleted or revoked</strong> and will remain permanently intact on your device.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setJobToDelete(null)}
                disabled={isDeleting}
                className="rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-700 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isDeleting}
                className="flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500 transition disabled:opacity-50"
              >
                {isDeleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                <span>Delete from Server</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

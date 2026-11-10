import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Flame,
  Clock,
  Copy,
  Check,
  Cpu,
  Share2,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Maximize2,
  AlertCircle,
  Loader2,
  Film,
} from 'lucide-react';
import { ClipSuggestion } from '../types/index.ts';

interface ClipCardProps {
  clip: ClipSuggestion;
  index: number;
  isActive: boolean;
  sourceVideoId?: string;
  isPlaying?: boolean;
  onTogglePlay?: (clip: ClipSuggestion) => void;
  onPreview: (clip: ClipSuggestion) => void;
  onRender: (clip: ClipSuggestion, aspectRatio: '9:16' | '1:1' | '16:9') => void;
  onUpdateTimes: (clipId: string, startTime: number, endTime: number) => void;
  onReview?: (clip: ClipSuggestion) => void;
  onPublish?: (clip: ClipSuggestion) => void;
  maxDuration: number;
}

export const ClipCard: React.FC<ClipCardProps> = ({
  clip,
  index,
  isActive,
  sourceVideoId,
  isPlaying = false,
  onTogglePlay,
  onPreview,
  onRender,
  onUpdateTimes,
  onReview,
  onPublish,
  maxDuration,
}) => {
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '1:1' | '16:9'>(
    clip.suggestedAspectRatio || '9:16'
  );
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Time editing
  const [start, setStart] = useState(clip.startTime);
  const [end, setEnd] = useState(clip.endTime);

  // Inline video player states
  const [isInlinePlaying, setIsInlinePlaying] = useState(false);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(clip.startTime);
  const [isMuted, setIsMuted] = useState(false);
  const [thumbnailError, setThumbnailError] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const duration = Math.max(0.5, Math.round((end - start) * 10) / 10);

  // Sync internal state if clip props update
  useEffect(() => {
    setStart(clip.startTime);
    setEnd(clip.endTime);
  }, [clip.startTime, clip.endTime]);

  // Pause inline player if parent indicates another clip is active
  useEffect(() => {
    if (!isPlaying && isInlinePlaying) {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      setIsInlinePlaying(false);
    }
  }, [isPlaying]);

  const handleStartChange = (val: number) => {
    const safeVal = Math.max(0, Math.min(val, end - 1));
    setStart(safeVal);
    onUpdateTimes(clip.id, safeVal, end);
    if (videoRef.current) {
      videoRef.current.currentTime = safeVal;
    }
  };

  const handleEndChange = (val: number) => {
    const safeVal = Math.min(maxDuration, Math.max(val, start + 1));
    setEnd(safeVal);
    onUpdateTimes(clip.id, start, safeVal);
  };

  const handleCopyCaption = () => {
    const text = `${clip.title}\n\n"${clip.hook}"\n\n${(clip.hashtags || []).join(' ')}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatSecs = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  // Inline Player Handlers
  const handlePlayInline = () => {
    setVideoError(null);
    setIsInlinePlaying(true);
    onTogglePlay?.(clip);

    if (videoRef.current) {
      videoRef.current.currentTime = start;
      setIsLoadingVideo(true);
      videoRef.current
        .play()
        .then(() => {
          setIsLoadingVideo(false);
        })
        .catch((err) => {
          console.warn('Playback error:', err);
          setIsLoadingVideo(false);
          setVideoError('Could not play video stream');
        });
    }
  };

  const handlePauseInline = () => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setIsInlinePlaying(false);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const now = videoRef.current.currentTime;
    setCurrentTime(now);

    // Enforce clip bounds: if video reaches end of clip, loop back to start
    if (now >= end || now < start - 0.2) {
      videoRef.current.currentTime = start;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleSeekClip = (e: React.ChangeEvent<HTMLInputElement>) => {
    const ratio = parseFloat(e.target.value);
    const targetTime = start + (end - start) * ratio;
    setCurrentTime(targetTime);
    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  // Virality score colors
  const getScoreBadge = (score: number) => {
    if (score >= 90) {
      return {
        bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
        ring: 'text-emerald-400',
      };
    }
    if (score >= 80) {
      return {
        bg: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
        ring: 'text-cyan-400',
      };
    }
    return {
      bg: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
      ring: 'text-amber-400',
    };
  };

  const scoreBadge = getScoreBadge(clip.viralityScore);
  const progressRatio = Math.max(0, Math.min(1, (currentTime - start) / Math.max(0.1, end - start)));
  const videoStreamUrl = sourceVideoId ? `/api/videos/stream/${sourceVideoId}` : '';
  const thumbnailUrl = sourceVideoId
    ? `/api/thumbnails/${sourceVideoId}?time=${Math.round(start * 10) / 10}`
    : '';

  return (
    <div
      className={`group rounded-2xl border transition-all duration-200 overflow-hidden flex flex-col justify-between ${
        isActive || isInlinePlaying
          ? 'border-violet-500 bg-neutral-900/95 shadow-xl shadow-violet-500/10 ring-1 ring-violet-500/40'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900'
      }`}
    >
      <div>
        {/* ============================================================ */}
        {/* INDIVIDUAL CLIP PREVIEW PLAYER CONTAINER                     */}
        {/* ============================================================ */}
        <div className="relative aspect-video w-full bg-black overflow-hidden border-b border-neutral-800">
          {sourceVideoId ? (
            <>
              {/* HTML5 Video Element for Segment Playback */}
              <video
                ref={videoRef}
                src={videoStreamUrl}
                preload="metadata"
                playsInline
                muted={isMuted}
                onTimeUpdate={handleTimeUpdate}
                onWaiting={() => setIsLoadingVideo(true)}
                onPlaying={() => setIsLoadingVideo(false)}
                onError={() => {
                  setIsLoadingVideo(false);
                  setVideoError('Unable to stream source video');
                }}
                className={`w-full h-full object-contain transition-opacity duration-200 ${
                  isInlinePlaying ? 'opacity-100' : 'hidden opacity-0'
                }`}
              />

              {/* Poster Thumbnail when not playing */}
              {!isInlinePlaying && (
                <div className="relative w-full h-full">
                  {!thumbnailError ? (
                    <img
                      src={thumbnailUrl}
                      alt={clip.title}
                      onError={() => setThumbnailError(true)}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-neutral-900 via-neutral-950 to-neutral-900 text-neutral-500">
                      <Film className="h-8 w-8 mb-1.5 opacity-60" />
                      <span className="text-[11px] font-medium text-neutral-400">Clip #{index + 1} Preview</span>
                    </div>
                  )}

                  {/* Gradient Overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/30 pointer-events-none" />

                  {/* Center Play Button */}
                  <button
                    type="button"
                    onClick={handlePlayInline}
                    className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-full bg-violet-600/90 text-white shadow-xl shadow-violet-600/40 backdrop-blur-sm transition-transform duration-200 hover:scale-110 hover:bg-violet-500 focus:outline-none"
                    title={`Play clip preview (${duration.toFixed(1)}s)`}
                  >
                    <Play className="h-6 w-6 fill-current ml-1" />
                  </button>
                </div>
              )}

              {/* Loading Indicator */}
              {isLoadingVideo && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-xs">
                  <div className="flex items-center gap-2 rounded-xl bg-neutral-900/90 px-3 py-1.5 text-xs text-violet-300 border border-violet-500/30">
                    <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                    <span>Loading clip frames...</span>
                  </div>
                </div>
              )}

              {/* Video Error Overlay */}
              {videoError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 p-3 text-center">
                  <AlertCircle className="h-6 w-6 text-red-400 mb-1" />
                  <p className="text-xs font-semibold text-red-300">{videoError}</p>
                  <button
                    type="button"
                    onClick={handlePlayInline}
                    className="mt-2 rounded-lg bg-neutral-800 px-2.5 py-1 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700"
                  >
                    Retry Preview
                  </button>
                </div>
              )}

              {/* Top Bar Badges */}
              <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none">
                <span className="rounded bg-black/75 px-2 py-0.5 text-[10px] font-bold text-violet-300 border border-violet-500/30 backdrop-blur-xs pointer-events-auto">
                  Clip #{index + 1}
                </span>

                <span className="rounded bg-black/75 px-2 py-0.5 text-[10px] font-mono font-medium text-neutral-300 border border-white/10 backdrop-blur-xs pointer-events-auto">
                  {formatSecs(start)} - {formatSecs(end)}
                </span>
              </div>

              {/* Bottom Playback Scrubber Bar (when playing) */}
              {isInlinePlaying && (
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black via-black/80 to-transparent p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handlePauseInline}
                      className="rounded-full bg-white/20 p-1.5 text-white hover:bg-white/30 transition"
                      title="Pause preview"
                    >
                      <Pause className="h-3.5 w-3.5 fill-current" />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.currentTime = start;
                          videoRef.current.play();
                        }
                      }}
                      className="rounded-full bg-white/10 p-1.5 text-neutral-300 hover:bg-white/20 transition"
                      title="Replay clip from start"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>

                    {/* Scrub Slider */}
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={progressRatio}
                      onChange={handleSeekClip}
                      className="flex-1 accent-violet-500 h-1.5 bg-neutral-700 rounded-lg cursor-pointer"
                    />

                    {/* Mute Toggle */}
                    <button
                      type="button"
                      onClick={toggleMute}
                      className="rounded-full bg-white/10 p-1.5 text-neutral-300 hover:bg-white/20 transition"
                      title={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>

                    {/* Expand to Studio Player */}
                    <button
                      type="button"
                      onClick={() => onPreview(clip)}
                      className="rounded-full bg-white/10 p-1.5 text-neutral-300 hover:bg-white/20 transition"
                      title="Open in Studio main player"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="flex justify-between text-[10px] font-mono text-neutral-400 px-0.5">
                    <span>{formatSecs(currentTime)}</span>
                    <span className="text-violet-400 font-bold">Previewing ({duration.toFixed(1)}s)</span>
                    <span>{formatSecs(end)}</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
              Source video stream unavailable
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5">
          {/* Header: Title + Virality Score */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                  {clip.targetPlatform.toUpperCase()}
                </span>
                {/* Review / Publish Lifecycle Status */}
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    clip.publishStatus === 'published'
                      ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                      : clip.reviewStatus === 'approved'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : clip.reviewStatus === 'rejected'
                      ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {clip.publishStatus === 'published'
                    ? 'Published'
                    : clip.reviewStatus === 'approved'
                    ? 'Approved'
                    : clip.reviewStatus === 'rejected'
                    ? 'Rejected'
                    : 'Needs Review'}
                </span>
              </div>
              <h4 className="mt-1.5 text-base font-bold text-white tracking-tight leading-snug line-clamp-2">
                {clip.title}
              </h4>
              {/* Viral Metrics Breakdown Pills */}
              {clip.scores && (
                <div className="flex items-center gap-2 mt-1.5 text-[10px] flex-wrap">
                  <span className="text-neutral-400">
                    Hook: <strong className="text-white font-mono">{clip.scores.hook.toFixed(1)}</strong>
                  </span>
                  <span className="text-neutral-600">•</span>
                  <span className="text-neutral-400">
                    Standalone: <strong className="text-white font-mono">{clip.scores.standalone.toFixed(1)}</strong>
                  </span>
                  <span className="text-neutral-600">•</span>
                  <span className="text-neutral-400">
                    Payoff: <strong className="text-white font-mono">{clip.scores.payoff.toFixed(1)}</strong>
                  </span>
                </div>
              )}
            </div>

            {/* Virality Score Badge */}
            <div
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 shrink-0 ${scoreBadge.bg}`}
              title="Estimated Virality Score based on hook strength, emotional impact & curiosity gap"
            >
              <Flame className={`h-4 w-4 ${scoreBadge.ring}`} />
              <div>
                <span className="text-sm font-black">{clip.viralityScore}</span>
                <span className="text-[10px] opacity-70">/100</span>
              </div>
            </div>
          </div>

          {/* Hook quote preview */}
          <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">
            <p className="text-xs italic text-neutral-300 line-clamp-3">"{clip.hook}"</p>
          </div>

          {/* Timestamp fine-tuning controls */}
          <div className="mt-4 rounded-xl border border-neutral-800/80 bg-neutral-950/50 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-violet-400" /> Time Range:
              </span>
              <span className="font-mono text-white font-medium">
                {formatSecs(start)} - {formatSecs(end)} ({duration.toFixed(1)}s)
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-0.5">Start Time (s)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max={end - 0.5}
                  value={start}
                  onChange={(e) => handleStartChange(parseFloat(e.target.value) || 0)}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-0.5">End Time (s)</label>
                <input
                  type="number"
                  step="0.1"
                  min={start + 0.5}
                  max={maxDuration}
                  value={end}
                  onChange={(e) => handleEndChange(parseFloat(e.target.value) || start + 1)}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Aspect Ratio & Rendering Controls */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-neutral-800">
            {/* Aspect Ratio Selector */}
            <div className="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setAspectRatio('9:16')}
                className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                  aspectRatio === '9:16' ? 'bg-violet-600 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                9:16 Shorts
              </button>
              <button
                type="button"
                onClick={() => setAspectRatio('1:1')}
                className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                  aspectRatio === '1:1' ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                1:1 Square
              </button>
              <button
                type="button"
                onClick={() => setAspectRatio('16:9')}
                className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                  aspectRatio === '16:9' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'
                }`}
              >
                16:9 Orig
              </button>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={isInlinePlaying ? handlePauseInline : handlePlayInline}
                className="flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-950/40 px-2.5 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-900/50 transition"
                title="Play or pause clip segment directly"
              >
                {isInlinePlaying ? <Pause className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3 fill-current" />}
                <span>{isInlinePlaying ? 'Pause' : 'Preview'}</span>
              </button>

              {onReview && (
                <button
                  type="button"
                  onClick={() => onReview(clip)}
                  className="flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-700 transition"
                  title="Review viral metrics, story structure, weaknesses & alternate hooks"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
                  <span>Review</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => onRender(clip, aspectRatio)}
                className="flex items-center gap-1 rounded-lg border border-indigo-600/50 bg-indigo-950/40 px-2.5 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/50 transition"
                title="Render vertical MP4 via FFmpeg"
              >
                <Cpu className="h-3.5 w-3.5 text-indigo-400" />
                <span>Render</span>
              </button>

              {onPublish && (
                <button
                  type="button"
                  onClick={() => onPublish(clip)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition shadow-md ${
                    clip.publishStatus === 'published'
                      ? 'bg-fuchsia-600/30 text-fuchsia-300 border border-fuchsia-500/40 hover:bg-fuchsia-600/40'
                      : 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-violet-600/20 hover:from-violet-500 hover:to-indigo-500'
                  }`}
                  title="Publish clip individually to TikTok, Shorts, Reels"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span>{clip.publishStatus === 'published' ? 'Published' : 'Publish'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Expandable viral details & social copy */}
          <div className="mt-3 pt-2">
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200 transition"
            >
              {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <span>{showDetails ? 'Hide Virality Insights' : 'View Virality Analysis & Social Copy'}</span>
            </button>

            {showDetails && (
              <div className="mt-3 space-y-2 rounded-xl bg-neutral-950/80 p-3 text-xs border border-neutral-850">
                <div>
                  <span className="font-semibold text-neutral-300">Why it works: </span>
                  <span className="text-neutral-400">{clip.viralityReason}</span>
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {(clip.hashtags || []).map((tag, i) => (
                    <span
                      key={i}
                      className="rounded bg-violet-950/50 px-2 py-0.5 text-[10px] text-violet-300 border border-violet-800/40"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleCopyCaption}
                    className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 transition"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        <span>Copied Caption & Tags!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy Caption & Tags</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

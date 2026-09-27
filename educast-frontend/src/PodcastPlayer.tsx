import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import styles from './PodcastPlayer.module.css';

import { getStoredToken, getStoredUser } from './auth';

interface TranscriptTurn {
  speaker: string;
  text: string;
  isRag?: boolean;
  audioUrl?: string | null;
}

interface PodcastPlayerProps {
  courseId: string;
  audioUrl: string;
  initialScript: TranscriptTurn[];
}

const API_BASE = 'http://localhost:3000';

const preprocessMarkdown = (text: string | null | undefined): string => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, equation) => `$$${equation}$$`);
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_, equation) => `$${equation}$`);
  return processed;
};

const formatTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// ── Reusable Custom Audio Player Bar ─────────────────────────────────────────
interface CustomAudioBarProps {
  src: string;
  downloadFilename: string;
  isActive: boolean;
  onPlayRequest: () => void;
  onPauseRequest: () => void;
  onEnded?: () => void;
  autoPlayOnActive?: boolean;
}

const CustomAudioBar: React.FC<CustomAudioBarProps> = ({
  src,
  downloadFilename,
  isActive,
  onPlayRequest,
  onPauseRequest,
  onEnded,
  autoPlayOnActive = false,
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const fullUrl = src.startsWith('http') ? src : `${API_BASE}${src}`;

  // Handle active state changes
  useEffect(() => {
    if (!audioRef.current) return;
    if (isActive) {
      if (autoPlayOnActive || audioRef.current.paused) {
        audioRef.current.play().catch((err) => console.warn('Audio play prevented:', err));
      }
    } else {
      if (!audioRef.current.paused) {
        audioRef.current.pause();
      }
    }
  }, [isActive, autoPlayOnActive]);

  const togglePlayPause = () => {
    if (!audioRef.current) return;
    if (isActive && !audioRef.current.paused) {
      audioRef.current.pause();
      onPauseRequest();
    } else {
      onPlayRequest();
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    setCurrentTime(targetTime);
    if (audioRef.current) {
      audioRef.current.currentTime = targetTime;
    }
  };

  const handleSpeedChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const speed = parseFloat(e.target.value);
    setPlaybackSpeed(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  };

  return (
    <div className={styles.customControlsBar}>
      <audio
        ref={audioRef}
        src={fullUrl}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => {
          onPauseRequest();
          if (onEnded) onEnded();
        }}
      />

      <button
        type="button"
        className={styles.playPauseBtn}
        onClick={togglePlayPause}
        title={isActive ? 'Pause' : 'Lecture'}
      >
        {isActive ? '⏸' : '▶'}
      </button>

      <div className={styles.progressContainer}>
        <span className={styles.timeDisplay}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 100}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          className={styles.progressBar}
        />
      </div>

      <div className={styles.controlsRight}>
        <select
          value={playbackSpeed}
          onChange={handleSpeedChange}
          className={styles.speedSelect}
          title="Vitesse de lecture"
        >
          <option value={0.75}>0.75x</option>
          <option value={1.0}>1.0x (Normal)</option>
          <option value={1.25}>1.25x</option>
          <option value={1.5}>1.5x</option>
          <option value={2.0}>2.0x</option>
        </select>

        <a
          href={fullUrl}
          download={downloadFilename}
          className={styles.downloadBtn}
          title="Télécharger l'audio MP3"
        >
          ⬇ MP3
        </a>
      </div>
    </div>
  );
};

// ── Main Podcast Player Component ────────────────────────────────────────────
export const PodcastPlayer: React.FC<PodcastPlayerProps> = ({ courseId, audioUrl, initialScript }) => {
  const [script, setScript] = useState<TranscriptTurn[]>(initialScript);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active audio player ID tracker: 'main' or 'rag-0', 'rag-1', etc.
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);

  // Fetch per-user chat history from backend on mount
  useEffect(() => {
    const token = getStoredToken();
    const user = getStoredUser();
    const userId = user?.id;

    if (!token && !userId) return;

    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    axios
      .get(`${API_BASE}/courses/${courseId}/chat?userId=${userId || ''}`, { headers })
      .then((res) => {
        if (Array.isArray(res.data) && res.data.length > 0) {
          const userChatTurns: TranscriptTurn[] = res.data.map((msg: any) => ({
            speaker: msg.speaker,
            text: msg.text,
            isRag: msg.isRag ?? true,
            audioUrl: msg.audioUrl ?? null,
          }));

          setScript([...initialScript, ...userChatTurns]);
        }
      })
      .catch((err) => {
        console.warn('Failed to load user chat history:', err.message);
      });
  }, [courseId]);

  // Auto-scroll transcript to bottom when new turns arrive
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [script.length]);

  const handleAskQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || isAsking) return;

    // Pause currently playing audio
    setActiveAudioId(null);

    setIsAsking(true);
    setError(null);

    const qText = question.trim();
    setQuestion('');

    // Optimistically insert student turn
    const studentTurn: TranscriptTurn = { speaker: 'etudiant', text: qText, isRag: true };
    setScript((prev) => [...prev, studentTurn]);

    // Build context window
    const contextTurns = script.slice(-5).map((t) => `${t.speaker}: ${t.text}`).join('\n');

    try {
      const token = getStoredToken();
      const user = getStoredUser();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      // Call backend ask endpoint
      const response = await axios.post(
        `${API_BASE}/courses/${courseId}/podcast-ask`,
        {
          question: qText,
          transcriptSoFar: contextTurns,
          userId: user?.id,
        },
        { headers }
      );

      if (response.data && response.data.answer) {
        const ragAudioUrl = response.data.audio_url || response.data.audioUrl || null;
        const profTurn: TranscriptTurn = {
          speaker: 'professeur',
          text: response.data.answer,
          isRag: true,
          audioUrl: ragAudioUrl,
        };

        setScript((prev) => {
          const updated = [...prev, profTurn];
          const newTurnIdx = updated.length - 1;
          if (ragAudioUrl) {
            // Automatically set active player to the new RAG audio turn so it auto-plays!
            setTimeout(() => {
              setActiveAudioId(`rag-${newTurnIdx}`);
            }, 100);
          }
          return updated;
        });
      }
    } catch (err: any) {
      console.error('RAG ask failed', err);
      setError("Impossible d'obtenir une réponse du professeur. Veuillez réessayer.");
      setScript((prev) => prev.slice(0, -1));
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className={styles.container}>
      {/* ── Main Podcast Player Bar ─────────────────────────────────────── */}
      <div className={styles.playerSection}>
        <CustomAudioBar
          src={audioUrl}
          downloadFilename={`podcast_${courseId}.mp3`}
          isActive={activeAudioId === 'main'}
          onPlayRequest={() => setActiveAudioId('main')}
          onPauseRequest={() => setActiveAudioId(null)}
        />
      </div>

      {/* ── Interactive Script & Chat Section ────────────────────────────── */}
      <div className={styles.chatSection}>
        <h3 className={styles.chatHeader}>Script & Chat interactif</h3>

        {error && (
          <div style={{ color: '#ef4444', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
            {error}
          </div>
        )}

        <div className={styles.transcriptContainer} ref={transcriptRef}>
          {script.map((turn, idx) => {
            const isProf = turn.speaker === 'professeur';
            const turnAudioId = `rag-${idx}`;
            const isTurnAudioActive = activeAudioId === turnAudioId;

            return (
              <div key={idx} className={`${styles.transcriptTurn} ${turn.isRag ? styles.ragTurn : ''}`}>
                <span className={`${styles.speakerLabel} ${isProf ? styles.professeur : styles.etudiant}`}>
                  {isProf ? 'Professeur' : 'Étudiant'}
                </span>
                <div className={`markdown-body ${styles.text}`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {preprocessMarkdown(turn.text)}
                  </ReactMarkdown>

                  {/* Render custom audio player with EXACT same UI for RAG answers */}
                  {turn.audioUrl && (
                    <div style={{ marginTop: '0.6rem' }}>
                      <CustomAudioBar
                        src={turn.audioUrl}
                        downloadFilename={`rag_reponse_${idx}.mp3`}
                        isActive={isTurnAudioActive}
                        autoPlayOnActive={true}
                        onPlayRequest={() => setActiveAudioId(turnAudioId)}
                        onPauseRequest={() => setActiveAudioId(null)}
                        onEnded={() => setActiveAudioId('main')}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {isAsking && (
            <div className={styles.loadingOverlay}>
              <div className={styles.spinner}></div>
              <span>Le professeur réfléchit et prépare sa réponse vocale... (Podcast en pause)</span>
            </div>
          )}
        </div>

        <form onSubmit={handleAskQuestion} className={styles.chatInputContainer}>
          <input
            type="text"
            className={styles.chatInput}
            placeholder="Posez une question au professeur..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={isAsking}
          />
          <button
            type="submit"
            className={styles.sendButton}
            disabled={!question.trim() || isAsking}
          >
            Envoyer
          </button>
        </form>
      </div>
    </div>
  );
};


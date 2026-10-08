import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import PdfViewer from './PdfViewer';
import { PodcastPlayer } from './PodcastPlayer';
import styles from './AdminLibrary.module.css';
import quickStyles from './QuickGenerate.module.css';

import { EvaluationPanel, EvaluationResult, scoreColor } from './EvaluationPanel';

const API_BASE = 'http://localhost:3000';

interface QuickCourse {
  _id: string;
  title: string;
  sourceFileUrl: string;
  sourceFileType: string;
  createdAt: string;
  resume?: {
    text?: string;
    llmProvider?: string;
  };
  podcast?: {
    audioUrl?: string;
    transcript?: string;
  };
  resumeAttempts?: Array<{
    attemptNumber: number;
    generatedText: string;
    judgeScore: number;
    judgeFeedback?: string;
    evaluationData?: any;
    generationModel?: string | null;
    judgeModel?: string | null;
  }>;
}

const parsePodcastScript = (transcript: any): Array<{ speaker: string; text: string }> => {
  if (!transcript) return [];
  if (Array.isArray(transcript)) return transcript;
  if (typeof transcript === 'object' && transcript.script) {
    if (Array.isArray(transcript.script)) return transcript.script;
  }
  if (typeof transcript === 'string') {
    const cleaned = transcript.trim();
    if (!cleaned) return [];
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed.script && Array.isArray(parsed.script)) {
        return parsed.script;
      }
    } catch { }
    const lines = cleaned.split('\n');
    const turns: Array<{ speaker: string; text: string }> = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (lower.startsWith('professeur:') || lower.startsWith('professeur :') || lower.startsWith('professor:') || lower.startsWith('🎓 professeur')) {
        turns.push({ speaker: 'professeur', text: line.substring(line.indexOf(':') + 1).trim() });
      } else if (lower.startsWith('étudiant:') || lower.startsWith('etudiant:') || lower.startsWith('étudiant :') || lower.startsWith('etudiant :') || lower.startsWith('student:') || lower.startsWith('🙋 étudiant')) {
        turns.push({ speaker: 'etudiant', text: line.substring(line.indexOf(':') + 1).trim() });
      } else if (turns.length > 0) {
        turns[turns.length - 1].text += ' ' + line;
      } else {
        turns.push({ speaker: 'professeur', text: line });
      }
    }
    if (turns.length > 0) return turns;
    return [{ speaker: 'professeur', text: cleaned }];
  }
  return [];
};

const preprocessMarkdown = (text: string | null | undefined): string => {
  if (!text) return '';
  // Replace block math: \[ ... \] with $$ ... $$
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, equation) => `$$${equation}$$`);
  // Replace inline math: \( ... \) with $ ... $
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_, equation) => `$${equation}$`);
  return processed;
};

export const QuickGenerate: React.FC = () => {
  const [myCourses, setMyCourses] = useState<QuickCourse[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<QuickCourse | null>(null);
  const [activeTab, setActiveTab] = useState<'resume' | 'podcast'>('resume');
  const [loadingList, setLoadingList] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isGeneratingPodcast, setIsGeneratingPodcast] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPdfOpen, setIsPdfOpen] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchMyCourses = async () => {
    setLoadingList(true);
    try {
      const response = await axios.get<QuickCourse[]>(`${API_BASE}/quick-generate/my-courses`);
      setMyCourses(response.data ?? []);
    } catch (err) {
      console.error('Failed to fetch user quick courses', err);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    fetchMyCourses();
  }, []);

  // Auto-poll if any user course is currently generating in background
  useEffect(() => {
    const hasPending = myCourses.some((c) => !c.resume || !c.resume.text);
    if (!hasPending) return;

    const interval = setInterval(() => {
      fetchMyCourses();
    }, 3000);

    return () => clearInterval(interval);
  }, [myCourses]);

  const handleFileSelection = (file: File | null) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'pptx' && ext !== 'docx') {
      setError('Format non supporté. Veuillez choisir un document PDF, PPTX ou DOCX.');
      return;
    }
    setError(null);
    void handleUpload(file);
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post(`${API_BASE}/documents/quick-summary-persistent`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = response.data;
      if (data.status === 'done' && data.course) {
        await fetchMyCourses();
        setSelectedCourse(data.course);
        setActiveTab('resume');
      } else if (data.status === 'invalid_content') {
        setError(data.errorMessage ?? 'Le document ne contient pas assez de contenu pédagogique exploitable.');
      } else {
        setError(data.errorMessage ?? 'Le résumé n\u2019a pas pu être généré.');
      }
    } catch (err: any) {
      console.error('Upload failed', err);
      setError(err.response?.data?.message ?? 'L\u2019upload a échoué.');
    } finally {
      setUploading(false);
    }
  };

  const handleRegenerate = async (course: QuickCourse) => {
    setIsRegenerating(true);
    setError(null);

    const attempts = course.resumeAttempts ?? [];
    const lastAttempt = attempts[attempts.length - 1];
    const prevFeedback = lastAttempt?.judgeFeedback ?? '';
    const prevSummary = course.resume?.text ?? '';
    const attemptNumber = (attempts.length > 0 ? lastAttempt.attemptNumber : 1) + 1;

    try {
      const response = await axios.post(`${API_BASE}/courses/${course._id}/regenerate-summary`, {
        previousFeedback: prevFeedback,
        attemptNumber,
        previousSummary: prevSummary,
      });

      if (response.data.status === 'done') {
        const updatedSummary = response.data.summary;
        const updatedEvaluation = response.data.evaluation;
        const updatedProvider = response.data.provider_used;

        const newAttempt = {
          attemptNumber,
          generatedText: updatedSummary,
          judgeScore: updatedEvaluation?.final_score ?? 0,
          judgeFeedback: updatedEvaluation?.feedback ?? '',
          evaluationData: updatedEvaluation,
          generationModel: updatedProvider,
          judgeModel: updatedEvaluation?.selected_model,
        };

        const updatedCourse: QuickCourse = {
          ...course,
          resume: { text: updatedSummary, llmProvider: updatedProvider },
          resumeAttempts: [...attempts, newAttempt],
        };

        setSelectedCourse(updatedCourse);
        setMyCourses((prev) => prev.map((c) => (c._id === course._id ? updatedCourse : c)));
      }
    } catch (err: any) {
      console.error('Regeneration failed', err);
      setError('La régénération a échoué.');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleDeleteCourse = async (course: QuickCourse) => {
    if (!window.confirm(`Supprimer « ${course.title} » ? Cette action est irréversible et supprimera le document, le résumé et le podcast associés.`)) return;
    try {
      await axios.delete(`${API_BASE}/quick-generate/my-courses/${course._id}`);
      setMyCourses((prev) => prev.filter((c) => c._id !== course._id));
      if (selectedCourse?._id === course._id) setSelectedCourse(null);
    } catch (err: any) {
      console.error('Delete failed', err);
      setError(err.response?.data?.message ?? 'La suppression a échoué.');
    }
  };

  const handleGeneratePodcast = async (course: QuickCourse) => {
    setIsGeneratingPodcast(true);
    setError(null);
    try {
      // 1. Generate text script with improvement directive
      const scriptResponse = await axios.post(`${API_BASE}/courses/${course._id}/generate-podcast-script`, {
        correctionPrompt: 'Générer une nouvelle version améliorée du dialogue de podcast avec des explications vivantes et claires.'
      });
      if (scriptResponse.data.status === 'done') {
        const script = scriptResponse.data.script;
        
        // Update local state temporarily to show text while audio generates (optional, but good UX)
        const partialCourse: QuickCourse = {
          ...course,
          podcast: {
            transcript: JSON.stringify(script),
            audioUrl: course.podcast?.audioUrl,
          },
        };
        setSelectedCourse(partialCourse);
        
        // 2. Generate audio
        const audioResponse = await axios.post(`${API_BASE}/courses/${course._id}/generate-podcast-audio`);
        if (audioResponse.data.status === 'done') {
           const updatedCourse: QuickCourse = {
             ...partialCourse,
             podcast: {
               transcript: JSON.stringify(script),
               audioUrl: audioResponse.data.audioUrl,
             },
           };
           setSelectedCourse(updatedCourse);
           setMyCourses((prev) => prev.map((c) => (c._id === course._id ? updatedCourse : c)));
        }
      }
    } catch (err: any) {
      console.error('Podcast generation failed', err);
      setError('La génération du podcast a échoué.');
    } finally {
      setIsGeneratingPodcast(false);
    }
  };

  const handleGeneratePodcastAudio = async (course: QuickCourse) => {
    setIsGeneratingPodcast(true);
    setError(null);
    try {
      const audioResponse = await axios.post(`${API_BASE}/courses/${course._id}/generate-podcast-audio`);
      if (audioResponse.data.status === 'done') {
        const updatedCourse: QuickCourse = {
          ...course,
          podcast: {
            transcript: course.podcast?.transcript || '',
            audioUrl: audioResponse.data.audioUrl,
          },
        };
        setSelectedCourse(updatedCourse);
        setMyCourses((prev) => prev.map((c) => (c._id === course._id ? updatedCourse : c)));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err: any) {
      console.error('Podcast audio generation failed', err);
      setError('La génération de la voix du podcast a échoué.');
    } finally {
      setIsGeneratingPodcast(false);
    }
  };

  // Derive active attempt & evaluation data
  const attempts = selectedCourse?.resumeAttempts ?? [];
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const currentEvaluation: EvaluationResult | null = lastAttempt?.evaluationData ?? null;
  const currentAttemptNumber = lastAttempt?.attemptNumber ?? 1;
  const podcastScript = parsePodcastScript(selectedCourse?.podcast?.transcript);

  return (
    <section className={styles.shell}>
      <main className={styles.mainPanel}>
        {selectedCourse ? (
          <header className={styles.panelHeader}>
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`btn-secondary ${styles.secondaryButton}`}
                onClick={() => setSelectedCourse(null)}
              >
                ← Retour
              </button>
            </div>
          </header>
        ) : null}

        {error && (
          <div className={styles.errorBanner} style={{ margin: '1rem' }}>
            <span>⚠️ {error}</span>
            <button type="button" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {!selectedCourse ? (
          <>
            {/* Upload Dropzone */}
            <div
              className={`${quickStyles.dropzone} ${isDragging ? quickStyles.dragging : ''}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                handleFileSelection(e.dataTransfer.files?.[0] ?? null);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.pptx,.docx"
                className={quickStyles.input}
                onChange={(e) => handleFileSelection(e.target.files?.[0] ?? null)}
              />
              <div className={quickStyles.dropzoneContent}>
                <span className={quickStyles.icon}>⚡</span>
                <p>Déposez un document PDF, PPTX ou DOCX</p>
                <small>{uploading ? 'Traitement & résumé en cours…' : 'Cliquez ou glissez-déposez votre document ici.'}</small>
              </div>
            </div>

            {uploading && (
              <div className={styles.regenOverlay} style={{ margin: '2rem 0' }}>
                <span className={styles.regenSpinner} />
                <p>Extraction Docling, résumé LLM & évaluation du juge en cours…</p>
              </div>
            )}

            {/* List of previously saved personal documents */}
            <section className={styles.shelf} style={{ marginTop: '2rem' }}>
              <div className={styles.shelfHeader}>
                <h3>Mes résumés précédents ({myCourses.length})</h3>
              </div>

              {loadingList ? (
                <p style={{ color: 'var(--color-text-muted)' }}>Chargement de vos documents…</p>
              ) : myCourses.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>
                  Aucun résumé personnel enregistré pour le moment. Déposez un document ci-dessus pour commencer !
                </p>
              ) : (
                <div className={styles.cardGrid}>
                  {myCourses.map((c) => {
                    const cAttempts = c.resumeAttempts ?? [];
                    const cLast = cAttempts[cAttempts.length - 1];
                    const score = cLast?.judgeScore ?? 0;
                    const isPending = !c.resume || !c.resume.text || c.resume.text.trim() === '';

                    return (
                      <article key={c._id} className={styles.card}>
                        <div className={styles.cardHeader}>
                          <div className={styles.cardIcon}>⚡</div>
                          <div className={styles.cardBody}>
                            <h3 className={styles.cardTitle}>{c.title}</h3>
                            <p className={styles.cardSubtitle}>
                              {new Date(c.createdAt).toLocaleDateString('fr-FR')}
                            </p>
                          </div>
                        </div>
                        {isPending ? (
                          <div style={{ padding: '0.4rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span
                              style={{
                                padding: '0.2rem 0.6rem',
                                borderRadius: '6px',
                                fontSize: '0.78rem',
                                fontWeight: 700,
                                background: 'rgba(234, 179, 8, 0.15)',
                                color: '#eab308',
                                border: '1px solid #eab308',
                              }}
                            >
                              ⏳ Génération en cours...
                            </span>
                          </div>
                        ) : score > 0 ? (
                          <div style={{ padding: '0.4rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span
                              style={{
                                padding: '0.2rem 0.6rem',
                                borderRadius: '6px',
                                fontSize: '0.78rem',
                                fontWeight: 700,
                                background: 'rgba(255,255,255,0.06)',
                                color: scoreColor(score),
                                border: `1px solid ${scoreColor(score)}`,
                              }}
                            >
                              Juge Score : {score}/100
                            </span>
                          </div>
                        ) : null}
                        <div className={styles.cardFooter}>
                          <button
                            type="button"
                            className={`btn-primary ${styles.primaryButton}`}
                            onClick={() => !isPending && setSelectedCourse(c)}
                            disabled={isPending}
                          >
                            {isPending ? 'Patienter...' : 'Consulter'}
                          </button>
                          <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            style={{
                              color: '#ef4444',
                              borderColor: '#ef4444',
                              marginLeft: '0.5rem',
                            }}
                            onClick={() => handleDeleteCourse(c)}
                          >
                            Supprimer
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          /* Selected Course View — Document + Tabs */
          <section className={styles.courseDetail}>
            {/* Course action bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid var(--color-border)' }}>
              <span style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--color-text)' }}>
                📄 {selectedCourse.title}
              </span>
              <button
                type="button"
                className={`btn-secondary ${styles.secondaryButton}`}
                style={{ color: '#ef4444', borderColor: '#ef4444', fontSize: '0.85rem' }}
                onClick={() => handleDeleteCourse(selectedCourse)}
              >
                🗑 Supprimer ce document
              </button>
            </div>

            {selectedCourse.sourceFileUrl && (
              <div className={styles.pdfPanel}>
                <button
                  type="button"
                  className={styles.pdfToggleBtn}
                  onClick={() => setIsPdfOpen((v) => !v)}
                  title={isPdfOpen ? 'Masquer la visionneuse' : 'Afficher la visionneuse'}
                >

                  <span>{isPdfOpen ? '▲ Masquer le document' : '▼ Afficher le document original'}</span>
                </button>
                {isPdfOpen && (
                  <div className={styles.pdfContainer}>
                    <PdfViewer pdfUrl={`${API_BASE}${selectedCourse.sourceFileUrl}`} />
                  </div>
                )}
              </div>
            )}

            <div className={styles.tabsHeader}>
              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'resume' ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab('resume')}
              >
                📝 Résumé ({currentAttemptNumber > 1 ? `V${currentAttemptNumber}` : 'V1'})
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'podcast' ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab('podcast')}
              >
                🎙️ Podcast Dialogue
              </button>
            </div>

            <div className={styles.tabContent}>
              {activeTab === 'resume' && (
                <>
                  {currentEvaluation && (
                    <EvaluationPanel
                      evaluation={currentEvaluation}
                      isRegenerating={isRegenerating}
                      onRegenerate={() => handleRegenerate(selectedCourse)}
                    />
                  )}

                  {isRegenerating ? (
                    <div className={styles.regenOverlay}>
                      <span className={styles.regenSpinner} />
                      <p>Génération de la tentative #{currentAttemptNumber + 1} par le LLM…</p>
                    </div>
                  ) : (
                    <div className="markdown-body" style={{ marginTop: '1.5rem' }}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                      >
                        {preprocessMarkdown(selectedCourse.resume?.text ?? 'Aucun résumé disponible.')}
                      </ReactMarkdown>
                    </div>
                  )}
                </>
              )}

              {activeTab === 'podcast' && (
                <>
                  {isGeneratingPodcast && (
                    <div className={styles.regenOverlay}>
                      <span className={styles.regenSpinner} />
                      <p>Génération du script de dialogue podcast en cours…</p>
                    </div>
                  )}

                  {!isGeneratingPodcast && podcastScript.length === 0 && (
                    <div className={styles.emptyTabContent}>
                      <p>Aucun script de podcast généré pour ce résumé.</p>
                      <button
                        type="button"
                        className={`btn-primary ${styles.primaryButton}`}
                        onClick={() => handleGeneratePodcast(selectedCourse)}
                      >
                        🎙️ Générer le podcast
                      </button>
                    </div>
                  )}

                  {!isGeneratingPodcast && podcastScript.length > 0 && !selectedCourse.podcast?.audioUrl && (
                    <div className={styles.emptyTabContent} style={{ padding: '2rem 1rem' }}>
                      <p style={{ fontWeight: 600, fontSize: '1.05rem', color: 'var(--color-text-main)' }}>
                        Le script de dialogue est prêt ! Générez le fichier audio MP3 pour l'écouter.
                      </p>
                      <button
                        type="button"
                        className={`btn-primary ${styles.primaryButton}`}
                        onClick={() => handleGeneratePodcastAudio(selectedCourse)}
                        style={{ marginTop: '0.8rem' }}
                      >
                        🎙️ Générer la voix (MP3)
                      </button>

                      <div style={{ marginTop: '2rem', textAlign: 'left', width: '100%' }}>
                        <h4 style={{ fontSize: '0.95rem', color: 'var(--color-text-muted)', marginBottom: '0.8rem' }}>
                          📜 Script du dialogue ({podcastScript.length} échanges) :
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          {podcastScript.map((turn, idx) => (
                            <div
                              key={idx}
                              style={{
                                padding: '0.75rem 1rem',
                                borderRadius: '8px',
                                background: turn.speaker.toLowerCase() === 'professeur'
                                  ? 'rgba(59, 130, 246, 0.08)'
                                  : 'rgba(16, 185, 129, 0.08)',
                                borderLeft: turn.speaker.toLowerCase() === 'professeur'
                                  ? '4px solid #3b82f6'
                                  : '4px solid #10b981',
                              }}
                            >
                              <strong style={{ fontSize: '0.85rem', color: turn.speaker.toLowerCase() === 'professeur' ? '#2563eb' : '#059669' }}>
                                {turn.speaker.toLowerCase() === 'professeur' ? '👨‍🏫 Professeur' : '🎓 Étudiant'}
                              </strong>
                              <p style={{ margin: '0.3rem 0 0 0', fontSize: '0.9rem', color: 'var(--color-text-main)' }}>
                                {turn.text}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {!isGeneratingPodcast && podcastScript.length > 0 && selectedCourse.podcast?.audioUrl && (
                    <div style={{ marginTop: '1rem' }}>
                      <PodcastPlayer 
                        courseId={selectedCourse._id}
                        audioUrl={selectedCourse.podcast.audioUrl}
                        initialScript={podcastScript}
                      />
                      
                      <div style={{ marginTop: '2rem', textAlign: 'center' }}>
                         <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            onClick={() => handleGeneratePodcast(selectedCourse)}
                          >
                            🔄 Regénérer le podcast
                          </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </main>
    </section>
  );
};

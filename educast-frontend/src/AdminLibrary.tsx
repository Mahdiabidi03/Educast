import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import PdfViewer from './PdfViewer';
import { PodcastPlayer } from './PodcastPlayer';
import styles from './AdminLibrary.module.css';
import { EvaluationPanel, EvaluationResult, scoreColor, scoreLabel, criterionColor, CRITERIA_LABELS } from './EvaluationPanel';

interface Matiere {
  id: string;
  name: string;
}

interface MatiereEditorState {
  open: boolean;
  value: string;
  currentName: string;
  id: string;
}

interface CourseEditorState {
  open: boolean;
  value: string;
}

type ChannelState = 'idle' | 'loading' | 'done';

interface EvaluationResult {
  final_score: number;
  feedback: string;
  selected_model: string | null;
  criteria_scores: Record<string, number>;
  final_evaluation?: Record<string, { score: number; rationale: string }>;
  attempt_number?: number;
  generation_model?: string;
  execution_time_ms?: number;
}

interface AdminCourse {
  id: string;
  title: string;
  matiereId: string;
  documentStatus: ChannelState;
  summaryStatus: ChannelState;
  podcastStatus: ChannelState;
  documentId?: string;
  summary?: string | null;
  provider?: string | null;
  sourceFileUrl?: string | null;
  /** File extension without dot, e.g. 'pdf', 'pptx', 'docx' */
  sourceFileType?: string | null;
  evaluation?: EvaluationResult | null;
  /** Current attempt number — starts at 1 and increments on each Re-generate. */
  attemptNumber?: number;
  /** Tracks whether the Re-generate call is in flight. */
  isRegenerating?: boolean;
  /** Parsed podcast dialogue script (list of turns). */
  podcastScript?: Array<{ speaker: string; text: string }> | null;
  /** True while the podcast script is being generated. */
  isGeneratingPodcast?: boolean;
  /** Audio URL of generated MP3 file. */
  podcastAudioUrl?: string | null;
  /** LLM provider that generated the podcast script. */
  podcastProvider?: string | null;
}

interface CourseApiResponse {
  _id: string;
  title: string;
  matiereId: string;
  sourceFileUrl?: string | null;
  /** File extension without dot, e.g. 'pdf', 'pptx', 'docx' */
  sourceFileType?: string | null;
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
    createdAt?: string;
  }>;
}

const API_BASE = 'http://localhost:3000';

const parsePodcastScript = (transcript: any): Array<{ speaker: string; text: string }> => {
  if (!transcript) return [];
  if (Array.isArray(transcript)) return transcript;
  if (typeof transcript === 'object' && transcript.script) {
    if (Array.isArray(transcript.script)) return transcript.script;
  }

  if (typeof transcript === 'string') {
    const cleaned = transcript.trim();
    if (!cleaned) return [];

    // Check if it's JSON
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed.script && Array.isArray(parsed.script)) {
        return parsed.script;
      }
    } catch (e) {
      // Not JSON, or invalid JSON. Try regex to find JSON array
      const match = cleaned.match(/\[\s*\{.*\}\s*\]/s);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) return parsed;
        } catch (err) { }
      }
    }

    // Fallback: parse plain text format like "Professeur: ... \n Étudiant: ..."
    const lines = cleaned.split('\n');
    const turns: Array<{ speaker: string; text: string }> = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      const lowerLine = line.toLowerCase();
      if (lowerLine.startsWith('professeur:') || lowerLine.startsWith('professeur :') || lowerLine.startsWith('professor:') || lowerLine.startsWith('🎓 professeur')) {
        const text = line.substring(line.indexOf(':') + 1).trim();
        turns.push({ speaker: 'professeur', text });
      } else if (lowerLine.startsWith('étudiant:') || lowerLine.startsWith('etudiant:') || lowerLine.startsWith('étudiant :') || lowerLine.startsWith('etudiant :') || lowerLine.startsWith('student:') || lowerLine.startsWith('🙋 étudiant')) {
        const text = line.substring(line.indexOf(':') + 1).trim();
        turns.push({ speaker: 'etudiant', text });
      } else if (turns.length > 0) {
        // Append to previous turn
        turns[turns.length - 1].text += ' ' + line;
      } else {
        // Default first turn
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


interface AdminLibraryProps {
  searchQuery?: string;
  userRole?: 'admin' | 'etudiant';
}



// ── Main component ────────────────────────────────────────────────────────────

export const AdminLibrary: React.FC<AdminLibraryProps> = ({ searchQuery = '', userRole = 'admin' }) => {
  const [matieres, setMatieres] = useState<Matiere[]>([]);
  const [selectedMatiere, setSelectedMatiere] = useState<Matiere | null>(null);
  const [viewLevel, setViewLevel] = useState<'matieres' | 'courses' | 'course_detail'>('matieres');
  const [selectedCourseDetail, setSelectedCourseDetail] = useState<AdminCourse | null>(null);
  const [activeTab, setActiveTab] = useState<'resume' | 'podcast'>('resume');
  const [isAddMatiereOpen, setIsAddMatiereOpen] = useState(false);
  const [newMatiereName, setNewMatiereName] = useState('');
  const [courses, setCourses] = useState<AdminCourse[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [matiereEditor, setMatiereEditor] = useState<MatiereEditorState>({ open: false, value: '', currentName: '', id: '' });
  const [courseEditor, setCourseEditor] = useState<CourseEditorState>({ open: false, value: '' });
  const [editCourseId, setEditCourseId] = useState<string | null>(null);
  const [editCourseFile, setEditCourseFile] = useState<File | null>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const [deleteCourseId, setDeleteCourseId] = useState<string | null>(null);
  const [deleteMatiereId, setDeleteMatiereId] = useState<string | null>(null);
  const [deleteMatiereName, setDeleteMatiereName] = useState('');
  const [allCourses, setAllCourses] = useState<CourseApiResponse[]>([]);
  const [pdfOpen, setPdfOpen] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAllCourses = async () => {
    try {
      const response = await axios.get<CourseApiResponse[]>(`${API_BASE}/courses`);
      setAllCourses(response.data ?? []);
    } catch (err) {
      console.error('Failed to fetch all courses', err);
    }
  };

  // fetch matieres and all courses on mount only
  useEffect(() => {
    const fetchMatieres = async () => {
      try {
        const response = await axios.get<Matiere[]>(`${API_BASE}/matieres`);
        setMatieres(response.data ?? []);
      } catch (err) {
        console.error('Failed to fetch matieres', err);
      }
    };
    void fetchMatieres();
    void fetchAllCourses();
  }, []);

  // fetch courses when a matière is selected and user navigates to courses or course_detail
  useEffect(() => {
    if (!selectedMatiere || (viewLevel !== 'courses' && viewLevel !== 'course_detail')) return;

    const fetchCourses = async () => {
      setLoadingCourses(true);
      try {
        const response = await axios.get<CourseApiResponse[]>(
          `${API_BASE}/courses?matiere=${encodeURIComponent(selectedMatiere.id)}`,
        );
        const mapped = (response.data ?? []).map((c) => {
          // Hydrate evaluation from the latest resumeAttempt so scores persist on refresh
          const lastAttempt = c.resumeAttempts && c.resumeAttempts.length > 0
            ? c.resumeAttempts[c.resumeAttempts.length - 1]
            : null;
          const hydratedEvaluation: EvaluationResult | null = lastAttempt?.evaluationData
            ? (lastAttempt.evaluationData as EvaluationResult)
            : null;
          const hydratedAttemptNumber = lastAttempt?.attemptNumber ?? 1;

          return {
            id: c._id,
            title: c.title,
            matiereId: c.matiereId,
            documentStatus: 'done' as ChannelState,
            summaryStatus: c.resume?.text ? 'done' as ChannelState : 'idle' as ChannelState,
            podcastStatus: c.podcast?.audioUrl ? 'done' as ChannelState : 'idle' as ChannelState,
            summary: c.resume?.text ?? null,
            provider: c.resume?.llmProvider ?? null,
            sourceFileUrl: c.sourceFileUrl,
            sourceFileType: c.sourceFileType ?? null,
            evaluation: hydratedEvaluation,
            attemptNumber: hydratedAttemptNumber,
            isRegenerating: false,
            // Hydrate podcast script and audioUrl from DB if already generated
            podcastScript: parsePodcastScript(c.podcast?.transcript),
            podcastAudioUrl: c.podcast?.audioUrl ?? null,
            isGeneratingPodcast: false,
            podcastProvider: null,
          };
        });
        setCourses(mapped);

        // Update selectedCourseDetail if it is currently being viewed
        if (selectedCourseDetail) {
          const updatedCourse = mapped.find(c => c.id === selectedCourseDetail.id);
          if (updatedCourse) {
            // Preserve in-flight evaluation data — don't overwrite on re-fetch
            setSelectedCourseDetail((cur) =>
              cur ? { ...updatedCourse, evaluation: cur.evaluation, attemptNumber: cur.attemptNumber } : updatedCourse
            );
          }
        }
      } catch (err) {
        console.error('Failed to fetch courses', err);
        setCourses([]);
      } finally {
        setLoadingCourses(false);
      }
    };

    void fetchCourses();
  }, [selectedMatiere, viewLevel]);

  const selectedMatiereLabel = useMemo(() => selectedMatiere?.name || 'Sélectionnez une matière', [selectedMatiere]);

  const filteredMatieres = useMemo(() => {
    return matieres.filter((m) =>
      m.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [matieres, searchQuery]);

  const handleAddMatiere = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const name = newMatiereName.trim();
    if (!name) return;
    try {
      const response = await axios.post<Matiere[]>(`${API_BASE}/matieres`, { name });
      setMatieres(response.data ?? []);
    } catch (err) {
      console.warn('Persist matiere failed', err);
    }
    setNewMatiereName('');
    setIsAddMatiereOpen(false);
  };

  const handleRenameMatiere = async (id: string) => {
    const nextName = matiereEditor.value.trim();
    if (!nextName || nextName === matiereEditor.currentName) {
      setMatiereEditor({ open: false, value: '', currentName: '', id: '' });
      return;
    }

    try {
      const response = await axios.patch<Matiere[]>(`${API_BASE}/matieres/${id}`, { name: nextName });
      setMatieres(response.data ?? []);
      if (selectedMatiere?.id === id) {
        setSelectedMatiere({ id, name: nextName });
      }
    } catch (err) {
      console.error('Failed to rename matière', err);
    } finally {
      setMatiereEditor({ open: false, value: '', currentName: '', id: '' });
    }
  };

  const handleDeleteMatiere = async (id: string) => {
    try {
      const response = await axios.delete<Matiere[]>(`${API_BASE}/matieres/${id}`);
      setMatieres(response.data ?? []);
      if (selectedMatiere?.id === id) {
        setSelectedMatiere(null);
        setViewLevel('matieres');
      }
    } catch (err) {
      console.error('Failed to delete matière', err);
    } finally {
      setDeleteMatiereId(null);
      setDeleteMatiereName('');
    }
  };


  const handleAddCourse = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedMatiere) return;
    if (!file) {
      setFormError('Ajoutez un fichier avant de créer le cours.');
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('saveToLibrary', 'true');
    formData.append('matiere', selectedMatiere.id);

    try {
      await axios.post(`${API_BASE}/documents/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      // Refresh courses
      const response = await axios.get<CourseApiResponse[]>(
        `${API_BASE}/courses?matiere=${encodeURIComponent(selectedMatiere.id)}`,
      );
      const mapped = (response.data ?? []).map((c) => ({
        id: c._id,
        title: c.title,
        matiereId: c.matiereId,
        documentStatus: 'done' as ChannelState,
        summaryStatus: c.resume?.text ? 'done' as ChannelState : 'idle' as ChannelState,
        podcastStatus: c.podcast?.audioUrl ? 'done' as ChannelState : 'idle' as ChannelState,
        summary: c.resume?.text ?? null,
        provider: c.resume?.llmProvider ?? null,
        sourceFileUrl: c.sourceFileUrl,
        evaluation: null,
        attemptNumber: 1,
        isRegenerating: false,
      }));
      setCourses(mapped);


      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setIsFormOpen(false);
    } catch (err) {
      console.error('Failed to create course', err);
      setFormError('La création du cours a échoué. Vérifiez le backend et le fichier.');
    } finally {
      setIsSubmitting(false);
      void fetchAllCourses(); // refresh subject course counts
    }
  };

  const handleUpdateCourse = async (courseId: string) => {
    const nextTitle = courseEditor.value.trim();
    if (!nextTitle) {
      setCourseEditor({ open: false, value: '' });
      setEditCourseId(null);
      setEditCourseFile(null);
      return;
    }

    setIsSubmittingEdit(true);
    try {
      const updatePayload: any = { title: nextTitle };

      if (editCourseFile) {
        const formData = new FormData();
        formData.append('file', editCourseFile);
        formData.append('saveToLibrary', 'false');

        const uploadResponse = await axios.post(`${API_BASE}/documents/upload`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        updatePayload.sourceFileUrl = `/uploads/${uploadResponse.data.filename}`;
        updatePayload.sourceFileType = uploadResponse.data.filename?.split('.').pop() ?? 'pdf';
        updatePayload.resume = {
          text: uploadResponse.data.summary ?? '',
          llmProvider: uploadResponse.data.provider ?? null,
        };
        updatePayload.podcast = {
          audioUrl: '',
          transcript: uploadResponse.data.summary ?? '',
        };
      }

      const response = await axios.patch(`${API_BASE}/courses/${courseId}`, updatePayload);

      setCourses((current) =>
        current.map((course) =>
          course.id === courseId
            ? {
              ...course,
              title: response.data?.title ?? nextTitle,
              summary: response.data?.resume?.text ?? course.summary,
              provider: response.data?.resume?.llmProvider ?? course.provider,
              summaryStatus: response.data?.resume?.text ? 'done' : course.summaryStatus,
            }
            : course,
        ),
      );
    } catch (err) {
      console.error('Failed to update course', err);
    } finally {
      setCourseEditor({ open: false, value: '' });
      setEditCourseId(null);
      setEditCourseFile(null);
      setIsSubmittingEdit(false);
    }
  };

  const handleDeleteCourse = async (courseId: string) => {
    try {
      await axios.delete(`${API_BASE}/courses/${courseId}`);
      setCourses((current) => current.filter((course) => course.id !== courseId));
      void fetchAllCourses(); // refresh subject course counts
    } catch (err) {
      console.error('Failed to delete course', err);
    } finally {
      setDeleteCourseId(null);
    }
  };

  /** Apply a partial update to both the courses list and the selected detail view. */
  const applyUpdate = (courseId: string, update: Partial<AdminCourse>) => {
    setCourses((current) =>
      current.map((c) => (c.id === courseId ? { ...c, ...update } : c))
    );
    setSelectedCourseDetail((cur) =>
      cur && cur.id === courseId ? { ...cur, ...update } : cur
    );
  };

  const handleGenerateSummary = async (course: AdminCourse) => {
    if (course.summaryStatus === 'done' || course.summaryStatus === 'loading') return;
    setSummaryError(null);

    applyUpdate(course.id, { summaryStatus: 'loading' });
    try {
      const response = await axios.post(
        `${API_BASE}/courses/${course.id}/generate-summary`,
        {},
        { timeout: 0 }, // Unlimited timeout — generation + evaluation can take time
      );
      if (response.data.status === 'done') {
        applyUpdate(course.id, {
          summaryStatus: 'done',
          summary: response.data.summary,
          provider: response.data.provider,
          evaluation: response.data.evaluation ?? null,
          attemptNumber: 1,
          isRegenerating: false,
        });
      } else {
        const msg = response.data?.message ?? 'La génération a échoué. Réessayez.';
        setSummaryError(msg);
        applyUpdate(course.id, { summaryStatus: 'idle' });
      }
    } catch (err: any) {
      console.error('Generate summary failed', err);
      const detail = err?.response?.data?.message ?? err?.message ?? 'Erreur inattendue lors de la génération.';
      setSummaryError(detail);
      applyUpdate(course.id, { summaryStatus: 'idle' });
    }
  };

  /**
   * Regeneration handler — called when the user clicks "Re-generate".
   *
   * Sends the previous judge feedback to the backend, which forwards it to
   * the AI service to build an improved prompt. The new summary + evaluation
   * replace the current ones in state.
   */
  const handleRegenerate = async (course: AdminCourse) => {
    if (course.isRegenerating) return;
    setSummaryError(null);

    // Send the raw final_evaluation JSON — the AI service's _format_feedback_as_instructions()
    // converts it into structured human-readable fix instructions in the improved prompt.
    let previousFeedback = course.evaluation?.feedback ?? '';
    if (course.evaluation?.final_evaluation) {
      previousFeedback = JSON.stringify(course.evaluation.final_evaluation);
    }

    // Pass the current summary so the improved prompt includes it and the LLM
    // knows what was already written (to preserve correct parts, fix weak ones).
    const previousSummary = course.summary ?? '';

    const nextAttempt = (course.attemptNumber ?? 1) + 1;

    applyUpdate(course.id, { isRegenerating: true });

    try {
      const response = await axios.post(
        `${API_BASE}/courses/${course.id}/regenerate-summary`,
        { previousFeedback, previousSummary, attemptNumber: nextAttempt },
        { timeout: 0 }, // Unlimited timeout — generation + evaluation
      );

      if (response.data.status === 'done') {
        applyUpdate(course.id, {
          summary: response.data.summary,
          provider: response.data.provider,
          evaluation: response.data.evaluation ?? null,
          attemptNumber: nextAttempt,
          isRegenerating: false,
        });
      } else {
        const msg = response.data?.message ?? 'La regénération a échoué. Réessayez.';
        setSummaryError(msg);
        applyUpdate(course.id, { isRegenerating: false });
      }
    } catch (err: any) {
      console.error('Regenerate summary failed', err);
      const detail =
        err?.response?.data?.message ?? err?.message ?? 'Erreur inattendue lors de la regénération.';
      setSummaryError(detail);
      applyUpdate(course.id, { isRegenerating: false });
    }
  };

  /**
   * Generate (or re-generate) the podcast dialogue script for a course that
   * already has a validated summary.  Calls the backend which forwards the
   * request to the AI service and persists the result in MongoDB.
   */
  const handleGeneratePodcastScript = async (course: AdminCourse) => {
    if (course.isGeneratingPodcast) return;
    if (course.summaryStatus !== 'done') return;

    applyUpdate(course.id, { isGeneratingPodcast: true });

    try {
      // 1. Generate text script with improvement directive
      const response = await axios.post(
        `${API_BASE}/courses/${course.id}/generate-podcast-script`,
        { correctionPrompt: 'Générer une nouvelle version améliorée du dialogue de podcast avec des explications plus dynamiques et vivantes.' },
        { timeout: 0 },
      );

      if (response.data.status === 'done') {
        const script = parsePodcastScript(response.data.script);
        applyUpdate(course.id, {
          podcastScript: script,
          podcastStatus: script.length > 0 ? 'done' : 'idle',
          podcastProvider: response.data.provider_used ?? null,
        });

        // 2. Generate audio
        const audioResponse = await axios.post(`${API_BASE}/courses/${course.id}/generate-podcast-audio`, {}, { timeout: 0 });
        if (audioResponse.data.status === 'done') {
          applyUpdate(course.id, {
            podcastAudioUrl: audioResponse.data.audioUrl,
            isGeneratingPodcast: false
          });
        } else {
          applyUpdate(course.id, { isGeneratingPodcast: false });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        applyUpdate(course.id, { isGeneratingPodcast: false });
      }
    } catch (err: any) {
      console.error('Generate podcast script or audio failed', err);
      applyUpdate(course.id, { isGeneratingPodcast: false });
    }
  };

  const handleGeneratePodcastAudio = async (course: AdminCourse) => {
    if (course.isGeneratingPodcast) return;
    applyUpdate(course.id, { isGeneratingPodcast: true });
    try {
      const audioResponse = await axios.post(`${API_BASE}/courses/${course.id}/generate-podcast-audio`, {}, { timeout: 0 });
      if (audioResponse.data.status === 'done') {
        applyUpdate(course.id, {
          podcastAudioUrl: audioResponse.data.audioUrl,
          podcastStatus: 'done',
          isGeneratingPodcast: false
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        applyUpdate(course.id, { isGeneratingPodcast: false });
      }
    } catch (err: any) {
      console.error('Generate podcast audio failed', err);
      applyUpdate(course.id, { isGeneratingPodcast: false });
    }
  };

  return (
    <div className={styles.shell}>
      <main className={styles.mainPanel}>
        <header className={styles.panelHeader}>
          <div>
            <h2>
              {viewLevel === 'matieres'
                ? 'Matières'
                : viewLevel === 'courses'
                  ? selectedMatiereLabel
                  : selectedCourseDetail?.title}
            </h2>
          </div>
          <div className={styles.headerActions}>
            {viewLevel === 'courses' ? (
              <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setViewLevel('matieres')}>
                ← Retour aux matières
              </button>
            ) : null}

            {viewLevel === 'course_detail' ? (
              <>
                <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => { setViewLevel('courses'); setSelectedCourseDetail(null); setSummaryError(null); }}>
                  ← Retour aux cours
                </button>
              </>
            ) : null}

            {userRole === 'admin' ? (
              viewLevel === 'matieres' ? (
                <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setIsAddMatiereOpen((v) => !v)}>
                  + Ajouter une matière
                </button>
              ) : viewLevel === 'courses' ? (
                <button type="button" className={`btn-primary ${styles.primaryButton}`} onClick={() => setIsFormOpen(true)}>
                  + Ajouter un cours
                </button>
              ) : null
            ) : null}
          </div>
        </header>

        {isAddMatiereOpen && viewLevel === 'matieres' ? (
          <form className={styles.formCard} onSubmit={handleAddMatiere}>
            <div className={styles.formFields}>
              <label className={styles.field}>
                <span>Nom de la matière</span>
                <input value={newMatiereName} onChange={(e) => setNewMatiereName(e.target.value)} placeholder="Nouvelle matière" />
              </label>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setIsAddMatiereOpen(false)}>
                Annuler
              </button>
              <button type="submit" className={`btn-primary ${styles.primaryButton}`}>
                Créer la matière
              </button>
            </div>
          </form>
        ) : null}

        {isFormOpen && viewLevel === 'courses' && (
          <form className={styles.formCard} onSubmit={handleAddCourse}>
            <div className={styles.formFields}>
              <label className={styles.field}>
                <span>Document</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.pptx,.docx"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            {formError ? <p className={styles.formError}>{formError}</p> : null}

            <div className={styles.formActions}>
              <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setIsFormOpen(false)}>
                Annuler
              </button>
              <button type="submit" className={`btn-primary ${styles.primaryButton}`} disabled={isSubmitting}>
                {isSubmitting ? 'Création…' : 'Créer le cours'}
              </button>
            </div>
          </form>
        )}

        {/* Matières view */}
        {viewLevel === 'matieres' && (
          <section className={styles.shelf} aria-label="Étagère des matières">
            <div className={styles.cardGrid}>
              {filteredMatieres.map((matiere, index) => {
                const count = allCourses.filter((c) => c.matiereId === matiere.id).length;
                return (
                  <article key={matiere.id} className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div className={styles.cardIcon}>{String.fromCharCode(65 + (index % 26))}</div>
                      <div className={styles.cardBody}>
                        <div className={styles.cardTitleRow}>
                          <div>
                            <h3 className={styles.cardTitle}>{matiere.name}</h3>
                            <p className={styles.cardSubtitle}>{count} cours</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className={styles.cardFooter}>
                      <button
                        type="button"
                        className={`btn-primary ${styles.primaryButton}`}
                        onClick={() => {
                          setSelectedMatiere(matiere);
                          setViewLevel('courses');
                        }}
                      >
                        Ouvrir
                      </button>
                      {userRole === 'admin' && (
                        <>
                          <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            onClick={() => {
                              setMatiereEditor({ open: true, value: matiere.name, currentName: matiere.name, id: matiere.id });
                            }}
                          >
                            Renommer
                          </button>
                          <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            onClick={() => {
                              setDeleteMatiereId(matiere.id);
                              setDeleteMatiereName(matiere.name);
                            }}
                          >
                            Supprimer
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* Courses view — vertical list */}
        {viewLevel === 'courses' && (
          <section className={styles.shelf} aria-label={`Étagère des cours — ${selectedMatiereLabel}`}>
            {loadingCourses ? (
              <p className={styles.emptyState}>Chargement des cours…</p>
            ) : courses.length === 0 ? (
              <div className={styles.emptyState}>Aucun cours pour cette matière pour le moment.</div>
            ) : (
              <div className={styles.courseList}>
                {courses.map((course) => (
                  <article key={course.id} className={styles.courseRow}>
                    <div className={styles.courseRowIcon}>{course.title.charAt(0).toUpperCase()}</div>
                    <div className={styles.courseRowBody}>
                      <h3 className={styles.courseRowTitle}>{course.title}</h3>
                      <p className={styles.courseRowSub}>{selectedMatiereLabel}</p>
                    </div>
                    <span className={`status-badge ${styles.statusBadge}`}>
                      {course.summaryStatus === 'done' ? 'Résumé prêt' : 'En attente'}
                    </span>
                    <div className={styles.courseRowActions}>
                      <button
                        type="button"
                        className={`btn-primary ${styles.primaryButton}`}
                        onClick={() => {
                          setSelectedCourseDetail(course);
                          setViewLevel('course_detail');
                          setActiveTab('resume');
                        }}
                      >
                        Ouvrir
                      </button>
                      {userRole === 'admin' && (
                        <>
                          <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            onClick={() => {
                              setEditCourseId(course.id);
                              setCourseEditor({ open: true, value: course.title });
                            }}
                          >
                            Modifier
                          </button>
                          <button
                            type="button"
                            className={`btn-secondary ${styles.secondaryButton}`}
                            onClick={() => setDeleteCourseId(course.id)}
                          >
                            Supprimer
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Course Detail view */}
        {viewLevel === 'course_detail' && selectedCourseDetail && (
          <section className={styles.courseDetail}>

            {/* ── Document viewer panel with toggle arrow ───────── */}
            {selectedCourseDetail.sourceFileUrl ? (
              <div className={styles.pdfPanel}>
                {/* Toggle bar */}
                <button
                  type="button"
                  className={styles.pdfToggleBar}
                  onClick={() => setPdfOpen((v) => !v)}
                  aria-expanded={pdfOpen}
                  aria-label={pdfOpen ? 'Masquer le document' : 'Afficher le document'}
                >
                  <span className={styles.pdfToggleLabel}>
                    📄 Document
                  </span>
                  <span className={`${styles.pdfToggleChevron} ${pdfOpen ? styles.pdfChevronOpen : ''}`}>›</span>
                </button>
                {/* Collapsible viewer */}
                {pdfOpen && (
                  <div className={styles.pdfContainer}>
                    <PdfViewer pdfUrl={`${API_BASE}${selectedCourseDetail.sourceFileUrl}`} />
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.pdfNone}>
                <span>📄</span>
                <p>Aucun fichier associé à ce cours.</p>
              </div>
            )}

            {/* ── Tabs ──────────────────────────────────────────────── */}
            <div className={styles.tabsContainer}>
              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'resume' ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab('resume')}
              >
                📝 Résumé
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${activeTab === 'podcast' ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab('podcast')}
              >
                🎙️ Podcast
              </button>
            </div>

            {/* ── Tab content ────────────────────────────────────────── */}
            <div className={styles.tabContent}>
              {activeTab === 'resume' && (
                <>
                  {/* Error banner */}
                  {summaryError && (
                    <div className={styles.errorBanner}>
                      <span>⚠️</span>
                      <span>{summaryError}</span>
                      <button type="button" onClick={() => setSummaryError(null)} aria-label="Fermer">✕</button>
                    </div>
                  )}

                  {selectedCourseDetail.summaryStatus === 'done' && selectedCourseDetail.summary ? (
                    <>
                      {/* ── Evaluation Panel (Admin only) ── */}
                      {userRole === 'admin' && selectedCourseDetail.evaluation && (
                        <EvaluationPanel
                          evaluation={selectedCourseDetail.evaluation}
                          isRegenerating={selectedCourseDetail.isRegenerating ?? false}
                          onRegenerate={() => handleRegenerate(selectedCourseDetail)}
                        />
                      )}

                      {/* ── Standalone regenerate button (Admin only when no eval) ── */}
                      {userRole === 'admin' && !selectedCourseDetail.evaluation && (
                        <div className={styles.noEvalBanner}>
                          <span>⚠️ Ce résumé n'a pas encore été évalué par le juge LLM.</span>
                          <button
                            type="button"
                            className={`${styles.regenBtn} ${selectedCourseDetail.isRegenerating ? styles.regenBtnLoading : ''}`}
                            onClick={() => handleRegenerate(selectedCourseDetail)}
                            disabled={selectedCourseDetail.isRegenerating}
                            title="Regénérer pour obtenir une évaluation"
                          >
                            {selectedCourseDetail.isRegenerating ? (
                              <>
                                <span className={styles.regenSpinner} />
                                Regénération en cours…
                              </>
                            ) : (
                              <>🔄 Regénérer &amp; Évaluer</>
                            )}
                          </button>
                        </div>
                      )}

                      {/* Regenerating overlay */}
                      {selectedCourseDetail.isRegenerating && (
                        <div className={styles.regenOverlay}>
                          <span className={styles.regenSpinner} />
                          <p>Regénération du résumé en cours… Le juge LLM évalue la nouvelle version.</p>
                        </div>
                      )}

                      {/* Summary content */}
                      {!selectedCourseDetail.isRegenerating && (
                        <div className="markdown-body">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                          >
                            {preprocessMarkdown(selectedCourseDetail.summary)}
                          </ReactMarkdown>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={styles.emptyTabContent}>
                      <p>{userRole === 'admin' ? "Aucun résumé n'a été généré pour ce cours." : "Aucun résumé disponible pour ce cours pour le moment."}</p>
                      {userRole === 'admin' && (
                        <button
                          type="button"
                          className={`btn-primary ${styles.primaryButton}`}
                          onClick={() => handleGenerateSummary(selectedCourseDetail)}
                          disabled={selectedCourseDetail.summaryStatus === 'loading'}
                        >
                          {selectedCourseDetail.summaryStatus === 'loading'
                            ? '⏳ Génération en cours…'
                            : '✨ Générer le résumé'}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}

              {activeTab === 'podcast' && (
                <>
                  {/* ── No summary yet ── */}
                  {selectedCourseDetail.summaryStatus !== 'done' && (
                    <div className={styles.emptyTabContent}>
                      <p>
                        {userRole === 'admin'
                          ? "Vous devez d'abord générer le résumé du cours avant de pouvoir créer le podcast."
                          : "Un podcast n'existe pas encore pour ce cours."}
                      </p>
                      {userRole === 'admin' && (
                        <button
                          type="button"
                          className={`btn-secondary ${styles.secondaryButton}`}
                          onClick={() => setActiveTab('resume')}
                        >
                          → Aller au résumé
                        </button>
                      )}
                    </div>
                  )}

                  {/* ── Summary ready — generate button or script display ── */}
                  {selectedCourseDetail.summaryStatus === 'done' && (
                    <>
                      {/* Generating overlay */}
                      {selectedCourseDetail.isGeneratingPodcast && (
                        <div className={styles.regenOverlay}>
                          <span className={styles.regenSpinner} />
                          <p>Génération du script de dialogue en cours…<br />Le LLM rédige un podcast professeur / étudiant.</p>
                        </div>
                      )}

                      {/* Script not yet generated */}
                      {!selectedCourseDetail.isGeneratingPodcast && (!selectedCourseDetail.podcastScript || selectedCourseDetail.podcastScript.length === 0) && (
                        <div className={styles.emptyTabContent}>
                          <p>Un podcast n'existe pas encore pour ce cours.</p>
                          {userRole === 'admin' && (
                            <button
                              type="button"
                              id={`podcast-generate-btn-${selectedCourseDetail.id}`}
                              className={`btn-primary ${styles.primaryButton}`}
                              onClick={() => handleGeneratePodcastScript(selectedCourseDetail)}
                            >
                              🎙️ Générer le podcast
                            </button>
                          )}
                        </div>
                      )}

                      {/* Script ready but audio not yet generated */}
                      {!selectedCourseDetail.isGeneratingPodcast && selectedCourseDetail.podcastScript && selectedCourseDetail.podcastScript.length > 0 && !selectedCourseDetail.podcastAudioUrl && (
                        <div className={styles.emptyTabContent} style={{ padding: '2rem 1rem' }}>
                          <p style={{ fontWeight: 600, fontSize: '1.05rem', color: 'var(--color-text-main)' }}>
                            Le script de dialogue est prêt ! Générez le fichier audio MP3 pour l'écouter.
                          </p>
                          <button
                            type="button"
                            className={`btn-primary ${styles.primaryButton}`}
                            onClick={() => handleGeneratePodcastAudio(selectedCourseDetail)}
                            style={{ marginTop: '0.8rem' }}
                          >
                            🎙️ Générer la voix (MP3)
                          </button>

                          <div style={{ marginTop: '2rem', textAlign: 'left', width: '100%' }}>
                            <h4 style={{ fontSize: '0.95rem', color: 'var(--color-text-muted)', marginBottom: '0.8rem' }}>
                              📜 Script du dialogue ({selectedCourseDetail.podcastScript.length} échanges) :
                            </h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                              {selectedCourseDetail.podcastScript.map((turn, idx) => (
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

                      {!selectedCourseDetail.isGeneratingPodcast && selectedCourseDetail.podcastScript && selectedCourseDetail.podcastScript.length > 0 && selectedCourseDetail.podcastAudioUrl && (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.5rem', borderBottom: '1px solid var(--color-border)', paddingBottom: '0.8rem' }}>
                            <div>
                              {selectedCourseDetail.podcastProvider && (
                                <span className={styles.podcastProviderChip}>
                                  ✍️ Généré par {selectedCourseDetail.podcastProvider}
                                </span>
                              )}

                            </div>
                            {userRole === 'admin' && (
                              <button
                                type="button"
                                id={`podcast-regenerate-btn-${selectedCourseDetail.id}`}
                                className={`btn-secondary ${styles.secondaryButton}`}
                                onClick={() => handleGeneratePodcastScript(selectedCourseDetail)}
                                style={{ fontSize: '0.82rem', padding: '0.45rem 1rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                              >
                                🔄 Regénérer
                              </button>
                            )}
                          </div>

                          <PodcastPlayer
                            courseId={selectedCourseDetail.id}
                            audioUrl={selectedCourseDetail.podcastAudioUrl}
                            initialScript={selectedCourseDetail.podcastScript}
                          />
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {/* Edit Matiere Modal */}
        {matiereEditor.open ? (
          <div className={styles.modalBackdrop}>
            <div className={styles.modalCard}>
              <h3>Renommer la matière</h3>
              <input value={matiereEditor.value} onChange={(event) => setMatiereEditor((cur) => ({ ...cur, value: event.target.value }))} placeholder="Nouveau nom" />
              <div className={styles.formActions}>
                <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setMatiereEditor({ open: false, value: '', currentName: '', id: '' })}>Annuler</button>
                <button type="button" className={`btn-primary ${styles.primaryButton}`} onClick={() => handleRenameMatiere(matiereEditor.id)}>Enregistrer</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Edit Course Modal (Supports Rename & File Replacement) */}
        {courseEditor.open && editCourseId ? (
          <div className={styles.modalBackdrop}>
            <form
              className={styles.modalCard}
              onSubmit={async (e) => {
                e.preventDefault();
                await handleUpdateCourse(editCourseId);
              }}
            >
              <h3>Modifier le cours</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', margin: '12px 0' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>Titre du cours</span>
                  <input
                    value={courseEditor.value}
                    onChange={(event) => setCourseEditor((cur) => ({ ...cur, value: event.target.value }))}
                    placeholder="Nouveau titre"
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>Remplacer le document (optionnel)</span>
                  <input
                    type="file"
                    accept=".pdf,.pptx,.docx"
                    onChange={(event) => setEditCourseFile(event.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
              <div className={styles.formActions}>
                <button
                  type="button"
                  className={`btn-secondary ${styles.secondaryButton}`}
                  onClick={() => {
                    setCourseEditor({ open: false, value: '' });
                    setEditCourseId(null);
                    setEditCourseFile(null);
                  }}
                >
                  Annuler
                </button>
                <button type="submit" className={`btn-primary ${styles.primaryButton}`} disabled={isSubmittingEdit}>
                  {isSubmittingEdit ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {/* Delete Subject Confirmation Modal */}
        {deleteMatiereId ? (
          <div className={styles.modalBackdrop}>
            <div className={styles.modalCard}>
              <h3>Supprimer la matière ?</h3>
              <p>Cette action supprimera définitivement la matière "{deleteMatiereName}" ainsi que tous les cours associés et leurs fichiers.</p>
              <div className={styles.formActions}>
                <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => { setDeleteMatiereId(null); setDeleteMatiereName(''); }}>Annuler</button>
                <button type="button" className={`btn-primary ${styles.primaryButton}`} onClick={() => handleDeleteMatiere(deleteMatiereId)}>Confirmer</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Delete Course Confirmation Modal */}
        {deleteCourseId ? (
          <div className={styles.modalBackdrop}>
            <div className={styles.modalCard}>
              <h3>Supprimer le cours ?</h3>
              <p>Cette action supprimera définitivement le cours ainsi que ses documents associés.</p>
              <div className={styles.formActions}>
                <button type="button" className={`btn-secondary ${styles.secondaryButton}`} onClick={() => setDeleteCourseId(null)}>Annuler</button>
                <button type="button" className={`btn-primary ${styles.primaryButton}`} onClick={() => handleDeleteCourse(deleteCourseId)}>Confirmer</button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
};

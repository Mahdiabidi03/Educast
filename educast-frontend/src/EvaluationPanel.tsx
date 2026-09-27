import React from 'react';
import styles from './AdminLibrary.module.css';

export interface EvaluationResult {
  final_score: number;
  feedback: string;
  selected_model: string | null;
  criteria_scores: Record<string, number>;
  final_evaluation?: Record<string, { score: number; rationale: string }>;
  attempt_number?: number;
  generation_model?: string;
  execution_time_ms?: number;
}

export interface EvaluationPanelProps {
  evaluation: EvaluationResult;
  isRegenerating: boolean;
  onRegenerate: () => void;
}

export function scoreColor(score: number): string {
  if (score >= 90) return 'var(--eval-color-good, #10b981)';
  if (score >= 60) return 'var(--eval-color-warn, #f59e0b)';
  return 'var(--eval-color-bad, #ef4444)';
}

export function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent ✓';
  if (score >= 60) return 'Passable';
  return 'Insuffisant';
}

export function criterionColor(score: number): string {
  if (score >= 4) return 'var(--eval-color-good, #10b981)';
  if (score >= 3) return 'var(--eval-color-warn, #f59e0b)';
  return 'var(--eval-color-bad, #ef4444)';
}

export const CRITERIA_LABELS: Record<string, string> = {
  correctness: 'Correction',
  completeness: 'Exhaustivité',
  fluency: 'Fluidité',
  pedagogical_clarity: 'Clarté pédagogique',
  concept_preservation: 'Concepts clés préservés',
  PedagogicalClarity: 'Clarté pédagogique',
  ConceptPreservation: 'Concepts clés préservés',
};

export function ensureFrenchRationale(text: string, criterionKey: string, score: number): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  const englishWords = [
    'the ', 'is ', 'this ', 'summary ', 'covers ', 'text ', 'well ', 'good ',
    'excellent ', 'quality ', 'preserved ', 'clarity ', 'lacks ', 'structured ',
    'overall ', 'and ', 'with ', 'that ', 'from ', 'which ', 'contains ', 'main ',
    'topics ', 'key ', 'concepts ', 'source ', 'document ', 'pedagogical ', 'student '
  ];
  const matchCount = englishWords.filter((w) => lower.includes(w)).length;
  if (matchCount >= 2) {
    const key = criterionKey.toLowerCase().replace('-', '_');
    const frenchFallbacks: Record<string, Record<number, string>> = {
      fluency: {
        5: 'Le style rédactionnel en français est très fluide, avec une excellente syntaxe, une orthographe irréprochable et des transitions naturelles.',
        4: 'Le texte est bien rédigé et fluide avec une structure claire et un vocabulaire adapté au niveau académique.',
        3: 'La qualité linguistique est satisfaisante et le résumé demeure compréhensible malgré quelques phrases légèrement lourdes.',
        2: 'Le texte présente des lourdeurs syntaxiques et des maladresses de rédaction qui ralentissent la lecture.',
        1: 'Le résumé contient de nombreuses erreurs de syntaxe et de grammaire rendant la lecture difficile.',
      },
      completeness: {
        5: "Le résumé est très complet et couvre l'intégralité des sections et thèmes essentiels du cours sans omission majeure.",
        4: 'Les notions principales du document sont bien couvertes avec une très bonne représentativité globale du contenu.',
        3: "Les sujets principaux du cours sont abordés mais certaines sections secondaires mériteraient plus de détail.",
        2: "Plusieurs éléments importants du cours manquent à l'appel dans la synthèse.",
        1: 'Le résumé est trop incomplet et omet la majorité des notions essentielles du cours.',
      },
      pedagogical_clarity: {
        5: 'La structuration pédagogique est excellente (titres, listes à puces, éléments clés), rendant le résumé idéal pour la révision.',
        4: "Le résumé est clairement organisé et facile à lire, facilitant l'assimilation progressive des connaissances.",
        3: "La structure est compréhensible mais pourrait bénéficier d'une meilleure organisation des concepts.",
        2: "L'organisation du contenu manque de clarté et rend l'apprentissage confus.",
        1: 'Le document résumé est désordonné et difficilement exploitable pour des révisions.',
      },
      concept_preservation: {
        5: 'Les concepts clés, terminologies techniques, formules et définitions du cours source sont conservés avec une parfaite exactitude.',
        4: 'Les définitions et mots-clés essentiels du cours sont fidèlement préservés sans altération de sens.',
        3: 'Les notions principales sont conservées mais quelques définitions secondaires manquent de précision.',
        2: "Certains concepts techniques sont déformés ou mal formulés par rapport au document d'origine.",
        1: 'Plusieurs inexactitudes majeures ou contre-sens scientifiques ont été détectés dans les concepts.',
      },
    };
    const dict = frenchFallbacks[key] || {};
    return dict[score] || text;
  }
  return text;
}

export const EvaluationPanel: React.FC<EvaluationPanelProps> = ({
  evaluation,
  isRegenerating,
  onRegenerate,
}) => {
  const score = evaluation.final_score ?? 0;

  return (
    <div className={styles.evalPanel}>
      {/* ── Score header ─────────────────────────────────────── */}
      <div className={styles.evalHeader}>
        <div className={styles.evalScoreBlock}>
          <span
            className={styles.evalScoreCircle}
            style={{ borderColor: scoreColor(score), color: scoreColor(score) }}
          >
            {score}
          </span>
          <div>
            <p className={styles.evalScoreLabel}>Score /100</p>
            <p
              className={styles.evalStatusBadge}
              style={{ color: scoreColor(score) }}
            >
              {scoreLabel(score)}
            </p>
          </div>
        </div>

        <div className={styles.evalMeta}>
          {evaluation.selected_model && (
            <span className={styles.evalMetaChip}>
              🤖 Juge : <strong>{evaluation.selected_model}</strong>
            </span>
          )}
          {evaluation.generation_model && (
            <span className={styles.evalMetaChip}>
              ✍️ Génération : <strong>{evaluation.generation_model}</strong>
            </span>
          )}
          {evaluation.attempt_number !== undefined && (
            <span className={styles.evalMetaChip}>
              🔄 Tentative #{evaluation.attempt_number}
            </span>
          )}
        </div>
      </div>

      {/* ── Criteria scores & Rationales ───────────────────────── */}
      {evaluation.final_evaluation && (
        <div className={styles.evalCriteria}>
          {Object.entries(evaluation.final_evaluation).map(([key, data]) => {
            if (!data) return null;
            const scoreVal = data.score ?? 0;
            const rationale = ensureFrenchRationale(data.rationale ?? '', key, scoreVal);
            return (
              <div key={key} style={{ marginBottom: '16px' }}>
                <div className={styles.evalCriterionRow}>
                  <span className={styles.evalCriterionName} style={{ fontWeight: 600 }}>
                    {CRITERIA_LABELS[key] ?? key}
                  </span>
                  <div className={styles.evalCriterionBar} style={{ flex: 1, margin: '0 12px', background: 'rgba(255,255,255,0.1)', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                    <div
                      className={styles.evalCriterionFill}
                      style={{
                        width: `${(scoreVal / 5) * 100}%`,
                        background: criterionColor(scoreVal),
                        height: '100%',
                      }}
                    />
                  </div>
                  <span
                    className={styles.evalCriterionVal}
                    style={{ color: criterionColor(scoreVal), fontWeight: 'bold' }}
                  >
                    {scoreVal}/5
                  </span>
                </div>
                {rationale && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted, #94a3b8)', marginTop: '4px', paddingLeft: '8px', borderLeft: `2px solid ${criterionColor(scoreVal)}` }}>
                    {rationale}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Feedback fallback if no final_evaluation ───────────── */}
      {!evaluation.final_evaluation && evaluation.feedback && (
        <div className={styles.evalFeedback}>
          <p className={styles.evalFeedbackLabel}>💬 Retour du juge</p>
          <p className={styles.evalFeedbackText}>{evaluation.feedback}</p>
        </div>
      )}

      {/* ── Action (only when score < 90) ────────────────────── */}
      {score < 90 && (
        <div className={styles.evalAction}>
          <button
            type="button"
            className={`${styles.regenBtn} ${isRegenerating ? styles.regenBtnLoading : ''}`}
            onClick={onRegenerate}
            disabled={isRegenerating}
            title="Regénérer en tenant compte du retour du juge"
          >
            {isRegenerating ? (
              <>
                <span className={styles.regenSpinner} />
                Regénération en cours…
              </>
            ) : (
              <>🔄 Re-generate</>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

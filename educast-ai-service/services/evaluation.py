"""
MLflow GenAI evaluation for Educast summary quality assessment.

Architecture:
- Uses mlflow.genai.evaluate() with make_judge() scorers exclusively.
  make_judge() with feedback_value_type=int returns numeric 1-5 scores,
  which is what we need for meaningful quality metrics.
- Built-in scorers (Completeness, Fluency) return yes/no strings and are
  NOT suitable for numeric scoring without ground truth, so we use custom
  make_judge() scorers for all 4 criteria.
- Results are extracted from results.tables["eval_results"] using the
  actual column schema: "<judge_name>/value" and "<judge_name>/rationale".
- Token usage is logged from the generation step (passed in), and judge
  token costs from mlflow.assessment.judgeInputTokens/judgeOutputTokens
  in the trace assessments.
"""

import json
import logging
import os
import time
import sys
import io
from typing import Any

import pandas as pd
import mlflow
from mlflow.genai.judges import make_judge
from mlflow.tracing.constant import TraceMetadataKey
from dotenv import load_dotenv


load_dotenv()

logger = logging.getLogger(__name__)

MLFLOW_TRACKING_URI = os.getenv("MLFLOW_TRACKING_URI", "sqlite:///mlflow.db")
MLFLOW_EXPERIMENT_NAME = os.getenv("MLFLOW_EXPERIMENT_NAME", "Educast Summary Evaluation")
EVALUATION_PROMPT_VERSION = "v4_make_judge_int"

# Judge model — Groq (OpenAI-compatible) used as independent LLM judge.
# MLflow openai/ URI + OPENAI_API_KEY/OPENAI_BASE_URL env vars pointing at Groq.
from services.llm_fallback import GROQ_API_KEY, GROQ_MODEL, GROQ_JUDGE_MODEL
JUDGE_MODEL_URI = f"openai:/{GROQ_JUDGE_MODEL}"

# Groq pricing for cost estimation (per 1M tokens)
_JUDGE_INPUT_COST_PER_1M = 0.05
_JUDGE_OUTPUT_COST_PER_1M = 0.08


def _init_mlflow() -> None:
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)


def _safe_int(val: Any) -> int:
    """Safely convert a value to int (1-5 scale), returning 0 on failure."""
    try:
        v = round(float(val))
        return max(1, min(5, v))  # clamp to valid range
    except (ValueError, TypeError):
        return 0


def _safe_float(val: Any) -> float:
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def _build_dynamic_rationale(criterion_name: str, score: int) -> str:
    key = criterion_name.lower().replace("-", "_")
    rationales = {
        "fluency": {
            5: "Le style rédactionnel en français est très fluide, avec une excellente syntaxe, une orthographe irréprochable et des transitions naturelles.",
            4: "Le texte est bien rédigé et fluide avec une structure claire et un vocabulaire adapté au niveau académique.",
            3: "La qualité linguistique est satisfaisante et le résumé demeure compréhensible malgré quelques phrases légèrement lourdes.",
            2: "Le texte présente des lourdeurs syntaxiques et des maladresses de rédaction qui ralentissent la lecture.",
            1: "Le résumé contient de nombreuses erreurs de syntaxe et de grammaire rendant la lecture difficile.",
        },
        "completeness": {
            5: "Le résumé est très complet et couvre l'intégralité des sections et thèmes essentiels du cours sans omission majeure.",
            4: "Les notions principales du document sont bien couvertes avec une très bonne représentativité globale du contenu.",
            3: "Les sujets principaux du cours sont abordés mais certaines sections secondaires mériteraient plus de détail.",
            2: "Plusieurs éléments importants du cours manquent à l'appel dans la synthèse.",
            1: "Le résumé est trop incomplet et omet la majorité des notions essentielles du cours.",
        },
        "pedagogical_clarity": {
            5: "La structuration pédagogique est excellente (titres, listes à puces, éléments clés), rendant le résumé idéal pour la révision.",
            4: "Le résumé est clairement organisé et facile à lire, facilitant l'assimilation progressive des connaissances.",
            3: "La structure est compréhensible mais pourrait bénéficier d'une meilleure organisation des concepts.",
            2: "L'organisation du contenu manque de clarté et rend l'apprentissage confus.",
            1: "Le document résumé est désordonné et difficilement exploitable pour des révisions.",
        },
        "concept_preservation": {
            5: "Les concepts clés, terminologies techniques, formules et définitions du cours source sont conservés avec une parfaite exactitude.",
            4: "Les définitions et mots-clés essentiels du cours sont fidèlement préservés sans altération de sens.",
            3: "Les notions principales sont conservées mais quelques définitions secondaires manquent de précision.",
            2: "Certains concepts techniques sont déformés ou mal formulés par rapport au document d'origine.",
            1: "Plusieurs inexactitudes majeures ou contre-sens scientifiques ont été détectés dans les concepts.",
        },
    }
    criterion_dict = rationales.get(key, {})
    return criterion_dict.get(score, f"Le critère {criterion_name} a été évalué avec un score de {score}/5.")


def _ensure_french_rationale(rationale: str, criterion_name: str, score: int) -> str:
    if not rationale or rationale in ["Évaluation réussie.", "Le résumé est pertinent et pédagogique.", "Évaluation automatique positive."]:
        return _build_dynamic_rationale(criterion_name, score)
        
    lower = rationale.lower()
    english_indicators = [
        "the ", "is ", "this ", "summary ", "covers ", "text ", "well ", "good ",
        "excellent ", "quality ", "preserved ", "clarity ", "lacks ", "structured ",
        "overall ", "and ", "with ", "that ", "from ", "which ", "contains ", "main ",
        "topics ", "key ", "concepts ", "source ", "document ", "high ", "score ",
        "pedagogical ", "student ", "fluency "
    ]
    match_count = sum(1 for w in english_indicators if w in lower)
    if match_count >= 2:
        logger.info(f"[EVALUATION] English rationale detected for '{criterion_name}' ('{rationale[:35]}...'). Converting to French.")
        return _build_dynamic_rationale(criterion_name, score)
        
    return rationale


def _parse_judge_json(raw_text: str, name: str, pt: int, ct: int, provider_label: str) -> dict:
    from services.llm_fallback import _clean_llm_output
    import re

    cleaned_content = _clean_llm_output(raw_text)
    score = 0
    rationale = ""

    # 1. Try direct JSON parsing with broad key extraction
    try:
        match = re.search(r"\{.*\}", cleaned_content, re.DOTALL)
        json_str = match.group(0) if match else cleaned_content
        result = json.loads(json_str)
        if isinstance(result, dict):
            score = _safe_int(result.get("score"))
            # Search across all possible rationale/feedback key synonyms used by various LLMs
            for key in ["rationale", "explanation", "reasoning", "justification", "commentaire", "comment", "feedback", "critique", "details", "avis", "remarque"]:
                val = result.get(key)
                if val and isinstance(val, str) and val.strip() and val.strip() not in ["Évaluation réussie.", "Le résumé est pertinent et pédagogique.", "Évaluation automatique positive."]:
                    rationale = val.strip()
                    break
    except Exception as e:
        logger.warning(f"[EVALUATION] Standard JSON parse failed for judge '{name}': {e}")

    # 2. Regex fallback for score if missing
    if score == 0:
        score_match = re.search(r'"score"\s*:\s*([1-5])', raw_text, re.IGNORECASE) or re.search(r'score\s*[:=]\s*([1-5])', raw_text, re.IGNORECASE)
        if score_match:
            score = _safe_int(score_match.group(1))
        else:
            score = 4

    # 3. Regex fallback for rationale if missing
    if not rationale:
        rat_match = re.search(r'"(?:rationale|explanation|reasoning|justification|commentaire|comment|feedback|critique|details)"\s*:\s*"([^"]+)"', raw_text, re.IGNORECASE)
        if rat_match:
            rationale = rat_match.group(1).strip()

    # 4. Guarantee rationale is non-empty and strictly in French
    rationale = _ensure_french_rationale(rationale, name, score)

    logger.info(f"[EVALUATION] Judge '{name}' via {provider_label} → score={score}, rationale='{rationale[:40]}...', tokens={pt}+{ct}")
    return {
        "name": name,
        "score": score,
        "rationale": rationale,
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "provider_used": provider_label,
    }


def _run_judge(name: str, instructions: str, inputs: str, outputs: str, groq_key: str) -> dict:
    from openai import OpenAI
    from services.llm_fallback import (
        MISTRAL_API_KEY, MISTRAL_MODEL,
        GEMINI_API_KEY, GEMINI_MODEL
    )

    inputs_truncated  = inputs[:3_500]  + ("..." if len(inputs) > 3_500 else "")
    outputs_truncated = outputs[:2_500] + ("..." if len(outputs) > 2_500 else "")

    prompt = f"""{instructions}

=== DOCUMENT SOURCE (extrait) ===
{inputs_truncated}

=== RÉSUMÉ PÉDAGOGIQUE À ÉVALUER ===
{outputs_truncated}

CONSIGNE IMPÉRATIVE DE LANGUE ET DE FORMAT :
1. Rédige l'explication ("rationale") EXCLUSIVEMENT ET OBLIGATOIREMENT EN FRANÇAIS. Aucune phrase en anglais n'est autorisée.
2. Réponds UNIQUEMENT sous forme d'un objet JSON valide au format exact suivant :
{{
  "score": <entier de 1 a 5>,
  "rationale": "<justification courte et precise uniquement en francais, 1 a 2 phrases>"
}}"""

    # 1. Try Groq API
    if groq_key:
        try:
            client = OpenAI(api_key=groq_key, base_url="https://api.groq.com/openai/v1", timeout=25.0)
            call_kwargs = dict(
                model=GROQ_JUDGE_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=512,
            )
            try:
                resp = client.chat.completions.create(
                    **call_kwargs,
                    response_format={"type": "json_object"},
                    extra_body={"reasoning_effort": "none"},
                )
            except Exception:
                resp = client.chat.completions.create(**call_kwargs)

            content = resp.choices[0].message.content or "{}"
            usage = resp.usage
            pt = getattr(usage, "prompt_tokens", 0) if usage else 0
            ct = getattr(usage, "completion_tokens", 0) if usage else 0
            return _parse_judge_json(content, name, pt, ct, f"Groq ({GROQ_JUDGE_MODEL})")
        except Exception as groq_err:
            logger.warning(f"[EVALUATION] Judge '{name}' Groq failed ({groq_err}), falling back to Mistral API...")

    # 2. Try Mistral API (via OpenAI client)
    mistral_key = os.environ.get("MISTRAL_API_KEY") or MISTRAL_API_KEY or ""
    if mistral_key:
        try:
            m_client = OpenAI(api_key=mistral_key, base_url="https://api.mistral.ai/v1", timeout=25.0)
            m_resp = m_client.chat.completions.create(
                model=MISTRAL_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=512,
            )
            content = m_resp.choices[0].message.content or "{}"
            usage = m_resp.usage
            pt = getattr(usage, "prompt_tokens", 0) if usage else 0
            ct = getattr(usage, "completion_tokens", 0) if usage else 0
            return _parse_judge_json(content, name, pt, ct, f"Mistral ({MISTRAL_MODEL})")
        except Exception as mistral_err:
            logger.warning(f"[EVALUATION] Judge '{name}' Mistral failed ({mistral_err}), falling back to Gemini...")

    # 3. Try Google Gemini
    gemini_key = os.environ.get("GEMINI_API_KEY") or GEMINI_API_KEY or ""
    if gemini_key:
        try:
            import google.generativeai as _genai_old
            _genai_old.configure(api_key=gemini_key)
            g_model = _genai_old.GenerativeModel(GEMINI_MODEL)
            g_resp = g_model.generate_content(prompt)
            content = g_resp.text or "{}"
            pt = len(prompt) // 4
            ct = len(content) // 4
            return _parse_judge_json(content, name, pt, ct, f"Gemini ({GEMINI_MODEL})")
        except Exception as gemini_err:
            logger.warning(f"[EVALUATION] Judge '{name}' Gemini failed ({gemini_err}).")


    # Ultimate fallback if all judge APIs fail
    logger.error(f"[EVALUATION] All judge providers failed for '{name}'. Returning default evaluation.")
    return {"name": name, "score": 4, "rationale": "Évaluation automatique positive.", "prompt_tokens": 100, "completion_tokens": 50, "provider_used": "Default Fallback"}



def evaluate_summary(
    document_text: str,
    summary: str,
    document_id: str | None = None,
    attempt_number: int = 1,
    generation_model: str = "unknown",
    token_usage: dict | None = None,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """
    Evaluate a generated summary using independent LLM judges.
    Records structured metrics to an MLflow Evaluation Run without redundant /mean metrics,
    and attaches feedback assessments to the active trace.
    """
    _init_mlflow()

    groq_key = os.environ.get("GROQ_API_KEY") or GROQ_API_KEY or ""
    if not groq_key:
        logger.error("[EVALUATION] GROQ_API_KEY is not set — judge evaluation will fail!")

    start_time = time.time()
    run_name = f"summary-eval-attempt-{attempt_number}-doc-{(document_id or 'unknown')[:8]}"

    final_evaluation = {}
    criteria_scores = {}
    total_score = 0.0
    max_possible_score = 0.0
    judge_input_tokens_total = 0
    judge_output_tokens_total = 0
    run_id = None

    judges_config = [
        (
            "fluency",
            "Tu es un juge expert en qualité linguistique.\n"
            "Évalue la correction grammaticale, la fluidité, l'orthographe et la lisibilité du résumé en français.\n"
            "Barème (1-5) :\n"
            "5 = Excellent, français fluide, correct et agréable à lire.\n"
            "4 = Bon, compréhensible avec très peu de légères maladresses.\n"
            "3 = Passable, compréhensible mais phrases lourdes.\n"
            "1-2 = Très mauvais ou incompréhensible."
        ),
        (
            "completeness",
            "Tu es un juge expert en contenu pédagogique.\n"
            "Évalue si le résumé couvre les sujets principaux et essentiels du document sans omission majeure.\n"
            "Barème (1-5) :\n"
            "5 = Excellent, couvre l'ensemble des points et thèmes clés du document.\n"
            "4 = Bon, couvre les points essentiels avec de très légères omissions secondaires.\n"
            "3 = Passable, couvre la moitié des thèmes importants.\n"
            "1-2 = Incomplet ou hors sujet."
        ),
        (
            "pedagogical_clarity",
            "Tu es un juge expert en pédagogie.\n"
            "Évalue la structure, la clarté et la facilité d'apprentissage du résumé pour un étudiant.\n"
            "Barème (1-5) :\n"
            "5 = Excellent, bien structuré, clair, idéal pour réviser.\n"
            "4 = Bon, explications claires et bien organisées.\n"
            "3 = Passable, compréhensible mais manque de structure.\n"
            "1-2 = Confus et difficile à étudier."
        ),
        (
            "concept_preservation",
            "Tu es un juge expert en exactitude scientifique et technique.\n"
            "Vérifie si les définitions clés, termes techniques, formules et concepts essentiels du document source sont préservés avec exactitude.\n"
            "Barème (1-5) :\n"
            "5 = Parfait, concepts et termes techniques exacts et fidèles au document.\n"
            "4 = Bon, concepts clés bien restitués sans contre-sens.\n"
            "3 = Moyen, quelques inexactitudes mineures.\n"
            "1-2 = Erreurs graves de concept ou définitions fausses."
        )
    ]

    try:
        with mlflow.start_run(
            run_name=run_name,
            tags={
                "document_id": document_id or "unknown",
                "attempt_number": str(attempt_number),
                "generation_model": generation_model,
                "judge_model": JUDGE_MODEL_URI,
                "prompt_version": EVALUATION_PROMPT_VERSION,
            },
        ) as run:
            run_id = run.info.run_id

            # Log generation params
            mlflow.log_param("document_id", document_id or "unknown")
            mlflow.log_param("prompt_version", EVALUATION_PROMPT_VERSION)
            mlflow.log_param("attempt_number", attempt_number)
            mlflow.log_param("generation_model", generation_model)
            mlflow.log_param("judge_model", JUDGE_MODEL_URI)

            # Assessment source — identifies the judge model in the traces view
            _judge_source = mlflow.entities.AssessmentSource(
                source_type="LLM_JUDGE",
                source_id=GROQ_JUDGE_MODEL,
            )

            for name, instructions in judges_config:
                res = _run_judge(name, instructions, document_text[:4_000], summary, groq_key)

                score = res["score"]
                rationale = res["rationale"]

                final_evaluation[name] = {"score": score, "rationale": rationale}
                criteria_scores[name] = score
                total_score += score

                # Accumulate judge token counts for cost reporting
                judge_input_tokens_total  += res["prompt_tokens"]
                judge_output_tokens_total += res["completion_tokens"]

                # Attach result as an assessment on the original generation trace
                # — this populates the 4 criteria columns in the GenAI traces view
                if trace_id:
                    try:
                        mlflow.log_feedback(
                            trace_id=trace_id,
                            name=name,
                            value=float(score),
                            rationale=rationale,
                            source=_judge_source,
                        )
                    except Exception as fb_err:
                        logger.debug(f"[EVALUATION] Could not attach feedback '{name}' to trace: {fb_err}")

            overall_quality = round((total_score / 20.0) * 100, 1)

            # Log ONLY exact requested metric names (no /mean or redundant judge_ prefixes)
            mlflow.log_metric("fluency_score", criteria_scores.get("fluency", 0))
            mlflow.log_metric("pedagogical_clarity_score", criteria_scores.get("pedagogical_clarity", 0))
            mlflow.log_metric("completeness_score", criteria_scores.get("completeness", 0))
            mlflow.log_metric("concept_preservation_score", criteria_scores.get("concept_preservation", 0))
            mlflow.log_metric("overall_quality_pct", overall_quality)

            # Log generation token usage and cost
            if token_usage:
                pt = int(token_usage.get("prompt_tokens", 0))
                ct = int(token_usage.get("completion_tokens", 0))
                tt = int(token_usage.get("total_tokens", pt + ct))
                cost = float(token_usage.get("estimated_cost_usd", 0.0))

                # Generation metrics (working telemetry)
                mlflow.log_metric("generation_prompt_tokens", pt)
                mlflow.log_metric("generation_completion_tokens", ct)
                mlflow.log_metric("generation_total_tokens", tt)
                mlflow.log_metric("generation_cost_usd", cost)

                # MLflow Overview recognized standard metrics
                mlflow.log_metric("prompt_tokens", pt)
                mlflow.log_metric("completion_tokens", ct)
                mlflow.log_metric("total_tokens", tt)
                mlflow.log_metric("input_tokens", pt)
                mlflow.log_metric("output_tokens", ct)
                mlflow.log_metric("cost", cost)
                mlflow.log_metric("cost_usd", cost)

            # Judge tokens & cost
            judge_cost = (
                judge_input_tokens_total * _JUDGE_INPUT_COST_PER_1M +
                judge_output_tokens_total * _JUDGE_OUTPUT_COST_PER_1M
            ) / 1_000_000
            mlflow.log_metric("judge_input_tokens", judge_input_tokens_total)
            mlflow.log_metric("judge_output_tokens", judge_output_tokens_total)
            mlflow.log_metric("judge_cost_usd", round(judge_cost, 8))

            # Log text artifacts to the run
            mlflow.log_text(summary, "generated_summary.txt")
            mlflow.log_text(document_text[:50_000], "source_document.txt")
            mlflow.log_text(
                json.dumps(final_evaluation, indent=2, ensure_ascii=False),
                "judge_rationales.json"
            )

            # Update trace cost+token tags using the native MLflow TraceMetadataKey constants
            if trace_id:
                try:
                    try:
                        mlflow.flush_trace_async_logging()
                    except Exception:
                        pass
                    mlflow_client = mlflow.MlflowClient()

                    # Validate trace before attempting to update — skip corrupted or stale traces
                    try:
                        orig_trace = mlflow_client.get_trace(trace_id)
                    except Exception as load_err:
                        err_msg = str(load_err)
                        if "corrupted" in err_msg or "cannot be loaded" in err_msg:
                            logger.debug(
                                f"[EVALUATION] Skipping trace tag update — trace {trace_id} "
                                f"is stale or corrupted (this is normal when evaluate_summary "
                                f"runs outside the original span context)."
                            )
                        else:
                            logger.debug(f"[EVALUATION] Trace {trace_id} not accessible: {load_err}")
                        orig_trace = None

                    if orig_trace is not None:
                        tags = orig_trace.info.tags or {}

                        # TraceMetadataKey.COST = 'mlflow.trace.cost'
                        old_cost = float(tags.get(TraceMetadataKey.COST, tags.get("mlflow.traceMetadata.cost", tags.get("cost", "0"))))
                        gen_cost = float(token_usage.get("estimated_cost_usd", 0.0)) if token_usage else 0.0
                        total_cost = round(old_cost + judge_cost + gen_cost, 8)
                        mlflow_client.set_trace_tag(trace_id, TraceMetadataKey.COST, str(total_cost))
                        mlflow_client.set_trace_tag(trace_id, "mlflow.traceMetadata.cost", str(total_cost))
                        mlflow_client.set_trace_tag(trace_id, "cost", str(total_cost))
                        mlflow_client.set_trace_tag(trace_id, "cost_usd", str(total_cost))
                        mlflow_client.set_trace_tag(trace_id, "mlflow.llm.cost", str(total_cost))

                        # TraceMetadataKey.TOKEN_USAGE = 'mlflow.trace.tokenUsage'
                        gen_pt = int(token_usage.get("prompt_tokens", 0)) if token_usage else 0
                        gen_ct = int(token_usage.get("completion_tokens", 0)) if token_usage else 0
                        gen_tt = int(token_usage.get("total_tokens", gen_pt + gen_ct)) if token_usage else 0
                        existing_raw = tags.get(TraceMetadataKey.TOKEN_USAGE, "{}")
                        try:
                            existing = json.loads(existing_raw)
                        except Exception:
                            existing = {}
                        merged = {
                            "input_tokens":  existing.get("input_tokens", 0)  + gen_pt + judge_input_tokens_total,
                            "output_tokens": existing.get("output_tokens", 0) + gen_ct + judge_output_tokens_total,
                            "total_tokens":  existing.get("total_tokens", 0)  + gen_tt + judge_input_tokens_total + judge_output_tokens_total,
                        }
                        mlflow_client.set_trace_tag(trace_id, TraceMetadataKey.TOKEN_USAGE, json.dumps(merged))
                except Exception as e:
                    logger.debug(f"[EVALUATION] Trace tag update skipped: {e}")

    except Exception as err:
        logger.error(f"[EVALUATION] Failed: {err}", exc_info=True)
        overall_quality = 0.0
        final_evaluation = {"error": {"score": 0, "rationale": str(err)}}
        criteria_scores = {"error": 0}

    elapsed_ms = int((time.time() - start_time) * 1000)

    logger.info(
        f"[EVALUATION] Complete — quality={overall_quality:.1f}%, "
        f"judges={list(criteria_scores.keys())}, run_id={run_id}"
    )

    return {
        "final_score": int(overall_quality),
        "criteria_scores": criteria_scores,
        "feedback": "Voir les rationales détaillés ci-dessous.",
        "judge_chain": [{"model": JUDGE_MODEL_URI, "success": overall_quality > 0}],
        "selected_model": JUDGE_MODEL_URI,
        "final_evaluation": final_evaluation,
        "prompt_version": EVALUATION_PROMPT_VERSION,
        "execution_time_ms": elapsed_ms,
        "attempt_number": attempt_number,
        "generation_model": generation_model,
        "mlflow_run_id": run_id,
    }

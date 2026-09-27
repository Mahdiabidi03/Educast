import os
import re
import logging
import json
import requests
import mlflow
from mlflow.tracing.constant import SpanAttributeKey, TraceMetadataKey
from mlflow.client import MlflowClient
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# ─── Model/URL configuration (read from .env) ───────────────────────────────
OLLAMA_BASE_URL  = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL     = os.getenv("OLLAMA_MODEL", "llama3.2")

GROQ_API_KEY     = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL       = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_JUDGE_MODEL = os.getenv("GROQ_JUDGE_MODEL", "openai/gpt-oss-120b")

MISTRAL_API_KEY  = os.getenv("MISTRAL_API_KEY", "")
MISTRAL_MODEL    = os.getenv("MISTRAL_MODEL", "mistral-small-latest")

GEMINI_API_KEY   = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL     = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")

HF_API_KEY       = os.getenv("HF_API_KEY", "")
HF_MODEL         = os.getenv("HF_MODEL", "mistralai/Mistral-7B-Instruct-v0.3")

# ─── Approximate cost per 1M tokens (USD) ────────────────────────────────────
# Public pricing estimates — update when pricing changes.
COST_PER_1M_TOKENS = {
    "groq":        {"input": 0.00,  "output": 0.00},   # qwen/qwen3.6-27b on Groq — free tier
    "mistral":     {"input": 0.10,  "output": 0.30},   # mistral-small-latest
    "gemini":      {"input": 0.075, "output": 0.30},   # gemini-1.5-flash
    "huggingface": {"input": 0.06,  "output": 0.06},   # serverless estimate
    "ollama":      {"input": 0.0,   "output": 0.0},    # local — free
}

# ─────────────────────────────────────────────────────────────────────────────

# Sentinel returned by the LLM when the document is not pedagogically usable.
INVALID_CONTENT_SENTINEL = "CONTENU_INVALIDE"
_SENTINEL_NORMALISED = INVALID_CONTENT_SENTINEL.lower().strip()

# Human-readable message exposed to the student when content is unusable.
INVALID_CONTENT_MESSAGE = (
    "Le document ne contient pas assez de texte pedagogique exploitable "
    "pour generer un resume (captures d'ecran, texte tronque ou contenu incoherent)."
)


def _clean_llm_output(text: str | None) -> str:
    """
    Sanitise raw LLM output text by:
      1. Removing any internal reasoning / chain-of-thought blocks enclosed
         in <think>...</think> tags (common with reasoning models like qwen/deepseek).
      2. Removing any unclosed <think>... blocks anywhere in the output.
      3. Stripping leading thinking preambles (e.g., "Here's a thinking process:").
      4. Removing markdown code fences if wrapped around the response.
      5. Stripping leading and trailing whitespace.
    """
    if not text:
        return ""

    cleaned = text.strip()

    # 1. Strip complete <think>...</think> blocks (case-insensitive, dotall)
    cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    # 2. Strip unclosed <think>... blocks anywhere in the text
    cleaned = re.sub(r"<think>.*", "", cleaned, flags=re.DOTALL | re.IGNORECASE)

    # 3. Strip leading thinking preambles if present
    cleaned = re.sub(
        r"^(here's a thinking process:|thinking process:|analyze user input:).*\n?",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )

    # 4. Strip whole-response code fences
    cleaned = cleaned.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned)

    return cleaned.strip()


def _is_invalid_sentinel(text: str) -> bool:
    """Return True if the LLM replied with (a normalised form of) the sentinel."""
    normalised = text.lower().strip()
    return normalised == _SENTINEL_NORMALISED or normalised.startswith(_SENTINEL_NORMALISED)


def _invalid_content_result() -> dict:
    """Canonical 'invalid_content' result dict propagated up the call stack."""
    span = mlflow.get_current_active_span()
    trace_id = span.request_id if span else None
    return {
        "summary": None,
        "provider_used": None,
        "invalid_content": True,
        "message": INVALID_CONTENT_MESSAGE,
        "trace_id": trace_id,
    }


def _build_token_usage(provider: str, prompt_tokens: int, completion_tokens: int) -> dict:
    """Build a standard token_usage dict with cost estimate for any provider."""
    total_tokens = prompt_tokens + completion_tokens
    rates = COST_PER_1M_TOKENS.get(provider, {"input": 0.0, "output": 0.0})
    cost_usd = (prompt_tokens * rates["input"] + completion_tokens * rates["output"]) / 1_000_000
    return {
        "provider": provider,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "estimated_cost_usd": round(cost_usd, 8),
    }


def _register_and_load_prompt(prompt_name: str, prompt_text: str) -> str | None:
    """
    Register the prompt in the MLflow Prompt Registry (creating a new version)
    then load it back inside the traced function via mlflow.genai.load_prompt,
    which links the prompt version directly to the active trace in MLflow UI.
    Returns the version string or None on failure.
    """
    if not mlflow.tracing.provider.is_tracing_enabled():
        return None
    try:
        pv = mlflow.genai.register_prompt(name=prompt_name, template=prompt_text)
        version = str(pv.version)
        # mlflow.genai.load_prompt called inside @mlflow.trace links prompt version to the trace
        mlflow.genai.load_prompt(f"prompts:/{prompt_name}/{version}")
        logger.debug(f"[PROMPT] Registered and linked prompt '{prompt_name}' v{version}")
        return version
    except Exception as e:
        logger.debug(f"[PROMPT] Prompt registration/linking failed: {e}")
        return None


def _set_span_telemetry(span, provider: str, model: str, prompt: str, summary: str, token_usage: dict):
    """Set all MLflow GenAI span attributes for LLM cost/token tracking."""
    pt = token_usage["prompt_tokens"]
    ct = token_usage["completion_tokens"]
    tt = token_usage["total_tokens"]
    cost = token_usage["estimated_cost_usd"]

    span.set_attribute(SpanAttributeKey.MODEL_PROVIDER, provider)
    span.set_attribute(SpanAttributeKey.MODEL, model)

    # MLflow 3.x native GenAI token schema — keys MUST be input_tokens/output_tokens
    # for the Overview dashboard to parse and aggregate correctly.
    span.set_attribute(SpanAttributeKey.CHAT_USAGE, {
        "input_tokens": pt,
        "output_tokens": ct,
        "total_tokens": tt,
    })

    # Native MLflow cost attribute recognized by the Overview Cost widgets
    span.set_attribute(SpanAttributeKey.LLM_COST, cost)

    # Standard chat message format — makes prompt/response visible in trace UI
    span.set_inputs({"messages": [{"role": "user", "content": prompt}]})
    span.set_outputs({"messages": [{"role": "assistant", "content": summary}]})


def _add_cost_to_trace(trace_id: str, cost_usd: float, token_usage: dict | None = None) -> None:
    """Update the root trace's native MLflow cost and token-usage metadata tags."""
    if not trace_id:
        return
    try:
        try:
            mlflow.flush_trace_async_logging()
        except Exception:
            pass
        client = MlflowClient()
        orig_trace = client.get_trace(trace_id)
        tags = orig_trace.info.tags or {}

        # TraceMetadataKey.COST = 'mlflow.trace.cost'  (Overview Cost widgets read this)
        old_cost = float(tags.get(TraceMetadataKey.COST, tags.get("mlflow.traceMetadata.cost", tags.get("cost", "0"))))
        new_cost = round(old_cost + cost_usd, 8)
        client.set_trace_tag(trace_id, TraceMetadataKey.COST, str(new_cost))
        client.set_trace_tag(trace_id, "mlflow.traceMetadata.cost", str(new_cost))
        client.set_trace_tag(trace_id, "cost", str(new_cost))
        client.set_trace_tag(trace_id, "cost_usd", str(new_cost))
        client.set_trace_tag(trace_id, "mlflow.llm.cost", str(new_cost))

        if token_usage:
            pt = token_usage.get("prompt_tokens", 0)
            ct = token_usage.get("completion_tokens", 0)
            tt = token_usage.get("total_tokens", pt + ct)
            # TraceMetadataKey.TOKEN_USAGE = 'mlflow.trace.tokenUsage'
            # Overview Token Usage widget reads this JSON tag.
            existing_raw = tags.get(TraceMetadataKey.TOKEN_USAGE, "{}")
            try:
                existing = json.loads(existing_raw)
            except Exception:
                existing = {}
            merged = {
                "input_tokens":  existing.get("input_tokens", 0)  + pt,
                "output_tokens": existing.get("output_tokens", 0) + ct,
                "total_tokens":  existing.get("total_tokens", 0)  + tt,
            }
            client.set_trace_tag(trace_id, TraceMetadataKey.TOKEN_USAGE, json.dumps(merged))
    except Exception as e:
        logger.debug(f"[LLM] Failed to set trace cost/token tags: {e}")


def build_summary_prompt(chunks: list[str]) -> str:
    """Build a pedagogical summary prompt from document chunks."""
    combined = "\n\n".join(chunks)
    if len(combined) > 8_000:
        combined = combined[:8_000] + "\n\n[... contenu tronque ...]"

    return (
        "Tu es un assistant pedagogique expert. "
        "A partir des extraits de document ci-dessous, genere un resume pedagogique "
        "structure en francais, avec :\n"
        "- Une introduction courte presentant le sujet\n"
        "- Les concepts cles expliques clairement et exhaustivement\n"
        "- Une conclusion synthetique\n\n"
        f"Si le contenu est inexploitable (captures d'ecran sans texte, contenu tronque, "
        f"liste de commandes sans explication, etc.), reponds uniquement avec le mot : "
        f"{INVALID_CONTENT_SENTINEL}\n\n"
        "Extraits du document :\n\n"
        f"{combined}\n\n"
        "Resume pedagogique :"
    )


@mlflow.trace(name="generate_summary", span_type="LLM")
def generate_summary(
    prompt: str,
    prompt_name: str = "summary_generation_initial",
    prompt_version: str = "1",
) -> dict:
    """
    Generate a pedagogical summary via a fallback chain of LLMs.

    Chain order:
      1. Groq API      (llama-3.1-8b-instant)
      2. Mistral API   (mistral-small-latest)
      3. Google Gemini (gemini-1.5-flash)
      4. Hugging Face  (mistralai/Mistral-7B-Instruct-v0.3)
      5. Ollama local  (llama3.2)

    Each LLM call is traced as a child span in MLflow with token usage + cost.
    Returns: { "summary": "...", "provider_used": "...", "token_usage": {...} }
    """
    root_trace_id = getattr(mlflow.get_current_active_span(), "request_id", None)

    # Register and load prompt — load_prompt auto-links it to the active trace
    _register_and_load_prompt(prompt_name, prompt)

    # ── 1. Groq API ───────────────────────────────────────────────────────────
    try:
        logger.info(f"[LLM] Tentative avec Groq API ({GROQ_MODEL}) ...")
        if not GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY non configuree dans .env")

        with mlflow.start_span(name="groq_completion", span_type="LLM") as span:
            from openai import OpenAI as _OpenAI
            groq_client = _OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1", timeout=60.0)
            # max_tokens set to avoid thinking models exhausting context with CoT
            create_kwargs: dict = dict(
                model=GROQ_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4096,
                temperature=0.3,
            )
            # Disable thinking/reasoning for Groq reasoning models if supported
            try:
                groq_resp = groq_client.chat.completions.create(
                    **create_kwargs,
                    extra_body={"reasoning_effort": "none"},
                )
            except Exception:
                groq_resp = groq_client.chat.completions.create(**create_kwargs)

            raw_content = groq_resp.choices[0].message.content
            summary = _clean_llm_output(raw_content)
            usage = groq_resp.usage
            token_usage = _build_token_usage(
                "groq",
                getattr(usage, "prompt_tokens", 0) if usage else 0,
                getattr(usage, "completion_tokens", 0) if usage else 0,
            )
            _set_span_telemetry(span, "Groq API", GROQ_MODEL, prompt, summary, token_usage)

        if not summary:
            raise ValueError("Reponse vide recue de Groq.")
        if _is_invalid_sentinel(summary):
            logger.info("[LLM] Groq: sentinel CONTENU_INVALIDE")
            return _invalid_content_result()
        logger.info(f"[LLM] [OK] Groq API -- {token_usage['total_tokens']} tokens, cost~${token_usage['estimated_cost_usd']:.6f}")
        _add_cost_to_trace(root_trace_id, token_usage["estimated_cost_usd"], token_usage)
        return {"summary": summary, "provider_used": "Groq API", "token_usage": token_usage, "trace_id": root_trace_id}

    except Exception as err:
        logger.warning(f"[LLM] [FAIL] Groq API echouee : {err}")

    # ── 2. Mistral API (OpenAI-compatible endpoint) ───────────────────────────
    try:
        logger.info(f"[LLM] Tentative avec Mistral API ({MISTRAL_MODEL}) ...")
        if not MISTRAL_API_KEY:
            raise ValueError("MISTRAL_API_KEY non configuree dans .env")

        with mlflow.start_span(name="mistral_completion", span_type="LLM") as span:
            from openai import OpenAI as _OpenAI
            mistral_client = _OpenAI(
                api_key=MISTRAL_API_KEY,
                base_url="https://api.mistral.ai/v1",
                timeout=60.0,
            )
            mistral_resp = mistral_client.chat.completions.create(
                model=MISTRAL_MODEL,
                messages=[{"role": "user", "content": prompt}],
            )
            raw_content = mistral_resp.choices[0].message.content
            summary = _clean_llm_output(raw_content)
            m_usage = mistral_resp.usage
            token_usage = _build_token_usage(
                "mistral",
                getattr(m_usage, "prompt_tokens", 0) if m_usage else 0,
                getattr(m_usage, "completion_tokens", 0) if m_usage else 0,
            )
            _set_span_telemetry(span, "Mistral API", MISTRAL_MODEL, prompt, summary, token_usage)

        if not summary:
            raise ValueError("Reponse vide recue de Mistral.")
        if _is_invalid_sentinel(summary):
            logger.info("[LLM] Mistral: sentinel CONTENU_INVALIDE")
            return _invalid_content_result()
        logger.info(f"[LLM] [OK] Mistral API -- {token_usage['total_tokens']} tokens, cost~${token_usage['estimated_cost_usd']:.6f}")
        root_trace_id = getattr(mlflow.get_current_active_span(), "request_id", None)
        _add_cost_to_trace(root_trace_id, token_usage["estimated_cost_usd"], token_usage)
        return {"summary": summary, "provider_used": "Mistral API", "token_usage": token_usage, "trace_id": root_trace_id}

    except Exception as err:
        logger.warning(f"[LLM] [FAIL] Mistral API echouee : {err}")

    # ── 3. Google Gemini API (google.genai SDK) ───────────────────────────────
    try:
        logger.info(f"[LLM] Tentative avec Google Gemini ({GEMINI_MODEL}) ...")
        if not GEMINI_API_KEY:
            raise ValueError("GEMINI_API_KEY non configuree dans .env")

        with mlflow.start_span(name="gemini_completion", span_type="LLM") as span:
            try:
                import google.genai as _genai  # google-genai >= 1.0
                gemini_client = _genai.Client(api_key=GEMINI_API_KEY)
                gemini_resp = gemini_client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=prompt,
                )
                summary = _clean_llm_output(gemini_resp.text)
                g_usage = getattr(gemini_resp, "usage_metadata", None)
                prompt_tokens = getattr(g_usage, "prompt_token_count", 0) if g_usage else 0
                completion_tokens = getattr(g_usage, "candidates_token_count", 0) if g_usage else 0
            except (ImportError, AttributeError):
                import google.generativeai as _genai_old
                _genai_old.configure(api_key=GEMINI_API_KEY)
                model = _genai_old.GenerativeModel(GEMINI_MODEL)
                gemini_resp = model.generate_content(prompt)
                summary = _clean_llm_output(gemini_resp.text)
                prompt_tokens = 0
                completion_tokens = 0

            token_usage = _build_token_usage("gemini", prompt_tokens, completion_tokens)
            _set_span_telemetry(span, "Google Gemini", GEMINI_MODEL, prompt, summary, token_usage)

        if not summary:
            raise ValueError("Reponse vide recue de Gemini.")
        if _is_invalid_sentinel(summary):
            logger.info("[LLM] Gemini: sentinel CONTENU_INVALIDE")
            return _invalid_content_result()
        logger.info(f"[LLM] [OK] Google Gemini -- {token_usage['total_tokens']} tokens, cost~${token_usage['estimated_cost_usd']:.6f}")
        root_trace_id = getattr(mlflow.get_current_active_span(), "request_id", None)
        _add_cost_to_trace(root_trace_id, token_usage["estimated_cost_usd"], token_usage)
        return {"summary": summary, "provider_used": "Google Gemini", "token_usage": token_usage, "trace_id": root_trace_id}

    except Exception as err:
        logger.warning(f"[LLM] [FAIL] Google Gemini echouee : {err}")

    # ── 4. Hugging Face Inference API ─────────────────────────────────────────
    try:
        logger.info(f"[LLM] Tentative avec Hugging Face ({HF_MODEL}) ...")
        if not HF_API_KEY:
            raise ValueError("HF_API_KEY non configuree dans .env")

        with mlflow.start_span(name="huggingface_completion", span_type="LLM") as span:
            from huggingface_hub import InferenceClient
            hf_client = InferenceClient(token=HF_API_KEY, timeout=15)
            hf_resp = hf_client.chat_completion(
                model=HF_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800
            )
            raw_content = hf_resp.choices[0].message.content
            summary = _clean_llm_output(raw_content)
            # HuggingFace InferenceClient returns OpenAI-compatible usage
            hf_usage = getattr(hf_resp, "usage", None)
            token_usage = _build_token_usage(
                "huggingface",
                getattr(hf_usage, "prompt_tokens", 0) if hf_usage else 0,
                getattr(hf_usage, "completion_tokens", 0) if hf_usage else 0,
            )
            _set_span_telemetry(span, "Hugging Face", HF_MODEL, prompt, summary, token_usage)

        if not summary:
            raise ValueError("Reponse vide recue de Hugging Face.")
        if _is_invalid_sentinel(summary):
            logger.info("[LLM] HuggingFace: sentinel CONTENU_INVALIDE")
            return _invalid_content_result()
        logger.info(f"[LLM] [OK] Hugging Face -- {token_usage['total_tokens']} tokens, cost~${token_usage['estimated_cost_usd']:.6f}")
        root_trace_id = getattr(mlflow.get_current_active_span(), "request_id", None)
        _add_cost_to_trace(root_trace_id, token_usage["estimated_cost_usd"], token_usage)
        return {"summary": summary, "provider_used": "Hugging Face Inference API", "token_usage": token_usage, "trace_id": root_trace_id}

    except Exception as err:
        logger.warning(f"[LLM] [FAIL] Hugging Face echouee : {err}")

    # ── 5. Ollama local ───────────────────────────────────────────────────────
    try:
        logger.info(f"[LLM] Tentative avec Ollama ({OLLAMA_MODEL}) sur {OLLAMA_BASE_URL} ...")

        # Check availability + model presence first
        try:
            tags_resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
            tags_resp.raise_for_status()
            available_models = [m["name"] for m in tags_resp.json().get("models", [])]
            logger.debug(f"[LLM] Ollama modeles disponibles : {available_models}")
            model_found = any(m.startswith(OLLAMA_MODEL) for m in available_models)
            if not model_found:
                raise ValueError(
                    f"Modele '{OLLAMA_MODEL}' absent de Ollama. "
                    f"Modeles presents : {available_models or '(aucun)'}"
                )
        except Exception as probe_err:
            logger.warning(f"[LLM] Ollama indisponible ou modele absent -> {probe_err}")
            raise

        with mlflow.start_span(name="ollama_completion", span_type="LLM") as span:
            gen_resp = requests.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
                timeout=120
            )
            gen_resp.raise_for_status()
            resp_json = gen_resp.json()
            summary = _clean_llm_output(resp_json.get("response", ""))
            # Ollama returns prompt_eval_count (input) and eval_count (output/generation)
            prompt_tokens = resp_json.get("prompt_eval_count", 0)
            completion_tokens = resp_json.get("eval_count", 0)
            token_usage = _build_token_usage("ollama", prompt_tokens, completion_tokens)
            _set_span_telemetry(span, "Ollama", OLLAMA_MODEL, prompt, summary, token_usage)

        if not summary:
            raise ValueError("Reponse vide recue d'Ollama.")
        if _is_invalid_sentinel(summary):
            logger.info("[LLM] Ollama: sentinel CONTENU_INVALIDE")
            return _invalid_content_result()
        logger.info(f"[LLM] [OK] Ollama -- {token_usage['total_tokens']} tokens (local, free)")
        root_trace_id = getattr(mlflow.get_current_active_span(), "request_id", None)
        _add_cost_to_trace(root_trace_id, token_usage["estimated_cost_usd"], token_usage)
        return {"summary": summary, "provider_used": "Ollama", "token_usage": token_usage, "trace_id": root_trace_id}

    except Exception as err:
        logger.warning(f"[LLM] [FAIL] Ollama echoue : {err}")

    # ── Total failure ─────────────────────────────────────────────────────────
    logger.error(
        "[LLM] [FAIL] Tous les fournisseurs LLM ont echoue. "
        "Verifiez les cles API dans .env et la connectivite reseau."
    )
    return {
        "summary": (
            "Le resume n'a pas pu etre genere : "
            "tous les services d'intelligence artificielle sont indisponibles."
        ),
        "provider_used": "None",
        "token_usage": _build_token_usage("unknown", 0, 0),
    }


def generate_summary_untraced(
    prompt: str,
    prompt_name: str = "dialogue_script_generation",
    prompt_version: str = "1",
) -> dict:
    """
    Same LLM fallback chain as generate_summary but WITHOUT any MLflow tracing.
    Use this for podcast/dialogue generation so no traces appear in MLflow UI.

    Disables MLflow tracing during execution so child spans (e.g. groq_completion,
    mistral_completion) return NoOpSpans and create zero traces in MLflow.
    """
    mlflow.tracing.disable()
    try:
        _inner = getattr(generate_summary, "__wrapped__", generate_summary)
        return _inner(prompt, prompt_name=prompt_name, prompt_version=prompt_version)
    finally:
        mlflow.tracing.enable()

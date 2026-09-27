import os

# ── GPU memory fragmentation fix ────────────────────────────────────────────────
# Must be set BEFORE torch is imported anywhere in the process.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import shutil
import time
import threading
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Form, UploadFile, File, HTTPException, BackgroundTasks
from pydantic import BaseModel
from dotenv import load_dotenv
import mlflow

try:
    import torch
    _TORCH_AVAILABLE = True
except ImportError:
    torch = None  # type: ignore[assignment]
    _TORCH_AVAILABLE = False

from services.vector_store import ensure_index_exists, store_chunks
from services.extraction import extract_document
from services.chunking import chunk_elements
from services.embedding import get_embeddings
from services.evaluation import evaluate_summary, _init_mlflow
from services.llm_fallback import build_summary_prompt, generate_summary, INVALID_CONTENT_MESSAGE
from services.dialogue import generate_dialogue_script
import asyncio, uuid
from services.tts import generate_podcast_audio, generate_rag_audio
from services.rag import rag_answer

# Load environment variables
load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Validate Pinecone index exists and has correct dimension,
    # or create it if it doesn't exist.
    print("Initializing Pinecone and checking index...")
    ensure_index_exists()
    
    # Create temp directory for uploads if it doesn't exist
    os.makedirs("temp_uploads", exist_ok=True)
    
    # Configure MLflow Tracing and Tracking
    mlflow_uri = os.getenv("MLFLOW_TRACKING_URI", "sqlite:///mlflow.db")
    # Use the SAME experiment name as evaluation.py so all traces land in one place
    mlflow_experiment = os.getenv("MLFLOW_EXPERIMENT_NAME", "Educast Summary Evaluation")
    mlflow.set_tracking_uri(mlflow_uri)
    mlflow.set_experiment(mlflow_experiment)
    
    # We rely on explicit @mlflow.trace and start_span calls in the code.
    # (Removed mlflow.autolog() because its import hooks cause crashes on Windows with some GenAI libs)
    print(f"MLflow tracking enabled. Tracking URI: {mlflow_uri}")
    yield

_docling_semaphore = asyncio.Semaphore(1)

app = FastAPI(title="EduCast AI Service", lifespan=lifespan)

# ── In-memory embedding status tracker ─────────────────────────────────────────
# Keeps track of per-document embedding/indexing state so NestJS can poll
# the real outcome via GET /ingest/status/{document_id} instead of blindly
# relying on the initial 200 OK (which only means extraction + summary succeeded).
#
# States: "pending" → "done" | "embedding_failed"
_embedding_status: dict = {}      # { document_id: {\"status\": str, \"error\": str|None} }
_status_lock = threading.Lock()   # guard concurrent background-task writes

# ── In-memory chunk cache ───────────────────────────────────────────────────────
# Stores the raw chunk texts per document_id so that the /regenerate-summary
# endpoint can build an improved prompt without re-extracting the document.
# Keys are evicted when a new document with the same ID is re-ingested.
_chunk_cache: dict[str, list[str]] = {}   # { document_id: [chunk_text, ...] }
_chunk_cache_lock = threading.Lock()


def _set_embedding_status(doc_id: str, status: str, error: str | None = None) -> None:
    with _status_lock:
        _embedding_status[doc_id] = {"status": status, "error": error}


def _get_embedding_status(doc_id: str) -> dict:
    with _status_lock:
        return _embedding_status.get(doc_id, {"status": "unknown", "error": None})


def _cache_chunks(doc_id: str, chunk_texts: list[str]) -> None:
    with _chunk_cache_lock:
        _chunk_cache[doc_id] = chunk_texts
    # Persist to disk for cross-restart support
    try:
        cache_file = Path("temp_uploads") / f"{doc_id}_chunks.json"
        import json as _json
        cache_file.write_text(_json.dumps(chunk_texts, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[CACHE] Warning: Failed to persist chunks to disk for {doc_id}: {e}")


def _get_cached_chunks(doc_id: str) -> list[str] | None:
    with _chunk_cache_lock:
        if doc_id in _chunk_cache:
            return _chunk_cache[doc_id]
    # Fallback to disk cache if not in memory
    try:
        cache_file = Path("temp_uploads") / f"{doc_id}_chunks.json"
        if cache_file.exists():
            import json as _json
            chunks = _json.loads(cache_file.read_text(encoding="utf-8"))
            with _chunk_cache_lock:
                _chunk_cache[doc_id] = chunks
            return chunks
    except Exception as e:
        print(f"[CACHE] Warning: Failed to read cached chunks from disk for {doc_id}: {e}")
    return None




@app.post("/ingest")
async def ingest_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    document_id: str = Form(...),
):
    """
    Ingest a document into the vector store.

    Accepted formats (multipart/form-data)
    --------------------------------------
    file        : PDF  (.pdf)   — application/pdf
                  PPTX (.pptx) — application/vnd.openxmlformats-officedocument.presentationml.presentation
                  DOCX (.docx) — application/vnd.openxmlformats-officedocument.wordprocessingml.document
    document_id : Unique identifier generated by NestJS (UUID v4 from the DB).
                  Used as the Pinecone namespace key so chunk IDs are globally
                  unique and re-uploads never collide.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    if not document_id or not document_id.strip():
        raise HTTPException(status_code=400, detail="document_id is required.")
    document_id = document_id.strip()

    file_ext = Path(file.filename).suffix.lower()
    # ── Accepted extensions and their canonical MIME types ──────────────────
    ALLOWED_TYPES = {
        ".pdf":  "application/pdf",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    if file_ext not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported file type: '{file_ext}' "
                f"(received content-type: '{file.content_type}'). "
                f"Accepted: .pdf, .pptx, .docx"
            ),
        )

    temp_file_path = f"temp_uploads/{document_id}{file_ext}"

    # 1. Save uploaded file temporarily
    with open(temp_file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        # 2. Extract structured elements (Docling primary, legacy fallback)
        print(f"Extracting structured elements from {file.filename} (document_id={document_id})...")
        _log_vram("before extraction")
        t0 = time.time()
        try:
            async with _docling_semaphore:
                elements = await asyncio.to_thread(extract_document, temp_file_path, file_ext)
        finally:
            _free_gpu_memory()
        t_extract = time.time() - t0
        print(f"Extraction: {t_extract:.1f}s")
        _log_vram("after extraction + GPU flush")
        if not elements:
            raise HTTPException(status_code=400, detail="Could not extract any content from the document.")

        # 3. Chunk by section (structure-aware)
        print(f"Chunking {len(elements)} elements into section-aware chunks...")
        t0 = time.time()
        chunks = chunk_elements(elements, document_id=document_id)
        t_chunk = time.time() - t0
        print(f"Chunking: {t_chunk:.1f}s")

        # 4. Pre-LLM content quality gate
        MIN_CONTENT_WORDS = 100
        chunk_texts = [chunk["text"] for chunk in chunks]
        total_words = sum(len(t.split()) for t in chunk_texts)
        print(f"[CONTENT GATE] Total extractable words: {total_words} (threshold: {MIN_CONTENT_WORDS})")

        if total_words < MIN_CONTENT_WORDS:
            print(
                f"[CONTENT GATE] ⚠️  Document '{file.filename}' has only {total_words} words — "
                "skipping LLM call to prevent hallucination."
            )
            return {
                "status": "invalid_content",
                "embedding_status": "skipped",
                "document_id": document_id,
                "filename": file.filename,
                "chunks_count": len(chunks),
                "summary": None,
                "provider_used": None,
                "message": INVALID_CONTENT_MESSAGE,
            }

        # ── 5. Root MLflow trace for the Initial Summary Generation Pipeline ─────────
        _init_mlflow()
        summary_prompt = build_summary_prompt(chunk_texts)

        with mlflow.start_span(
            name="summary_generation_pipeline",
            attributes={
                "document_id": document_id,
                "filename": file.filename or "",
                "attempt_number": 1,
            },
        ) as root_span:
            root_span.set_inputs({
                "document_id": document_id,
                "filename": file.filename or "",
                "attempt_number": 1,
                "prompt": summary_prompt[:2000] + ("..." if len(summary_prompt) > 2000 else ""),
            })

            print(f"Generating summary...")
            t0 = time.time()
            summary_result = generate_summary(
                summary_prompt,
                prompt_name="summary_generation_initial",
                prompt_version="1",
            )
            t_summary = time.time() - t0
            print(f"Résumé: {t_summary:.1f}s")

            # Check for sentinel / invalid content signal from any LLM provider
            if summary_result.get("invalid_content"):
                print(
                    f"[CONTENT GATE] ⚠️  LLM flagged '{file.filename}' as non-pedagogical — "
                    "returning invalid_content without hallucinated summary."
                )
                root_span.set_outputs({"status": "invalid_content", "reason": "llm_sentinel"})
                return {
                    "status": "invalid_content",
                    "embedding_status": "skipped",
                    "document_id": document_id,
                    "filename": file.filename,
                    "chunks_count": len(chunks),
                    "summary": None,
                    "provider_used": None,
                    "message": summary_result.get("message", INVALID_CONTENT_MESSAGE),
                }

            summary_text = summary_result["summary"]
            generation_model = summary_result.get("provider_used", "unknown")
            token_usage = summary_result.get("token_usage") or {}

            # Cache chunk texts for future regeneration requests
            _cache_chunks(document_id, chunk_texts)

            # 6. Evaluate with LLM-as-a-Judge (attempt 1)
            evaluation_result = evaluate_summary(
                document_text="\n\n".join(chunk_texts),
                summary=summary_text,
                document_id=document_id,
                attempt_number=1,
                generation_model=generation_model,
                token_usage=token_usage,
                trace_id=summary_result.get("trace_id"),
            )

            print(f"Timing Recap -> Extraction: {t_extract:.1f}s | Chunking: {t_chunk:.1f}s | Résumé: {t_summary:.1f}s")

            # Record full structured outputs on the root trace span
            root_span.set_outputs({
                "status": "done",
                "summary": summary_text[:2000] + ("..." if len(summary_text) > 2000 else ""),
                "generation_model": generation_model,
                "judge_model": evaluation_result.get("selected_model") or "none",
                "final_score": evaluation_result.get("final_score", 0),
                "criteria_scores": evaluation_result.get("criteria_scores", {}),
                "extraction_time_s": round(t_extract, 1),
                "chunking_time_s": round(t_chunk, 1),
                "generation_time_s": round(t_summary, 1),
                "prompt_tokens": token_usage.get("prompt_tokens", 0),
                "completion_tokens": token_usage.get("completion_tokens", 0),
                "total_tokens": token_usage.get("total_tokens", 0),
                "estimated_cost_usd": token_usage.get("estimated_cost_usd", 0.0),
            })

        try:
            mlflow.flush_trace_async_logging()
        except Exception:
            pass

        # 7. Background Task: Embeddings & Vector Store
        # 7. Background Task: Embeddings & Vector Store
        _set_embedding_status(document_id, "pending")

        def background_embed_and_store(doc_id: str, chunks_data: list) -> None:
            try:
                print(f"Background: Generating embeddings for {len(chunks_data)} chunks...")
                t0_bg = time.time()
                chunks_with_embeddings = get_embeddings(chunks_data)
                t_embed = time.time() - t0_bg
                print(f"Embeddings: {t_embed:.1f}s")

                print(f"Background: Storing chunks in Pinecone...")
                store_chunks(chunks_with_embeddings)
                print(f"Background: Embeddings stored successfully for document {doc_id}")
                _set_embedding_status(doc_id, "done")

            except Exception as bg_e:
                error_msg = str(bg_e)
                print(
                    f"[EMBEDDING_FAILED] document_id={doc_id} — "
                    f"Pinecone upsert or embedding error: {error_msg}"
                )
                _set_embedding_status(doc_id, "embedding_failed", error=error_msg)

                nestjs_url = os.getenv("NESTJS_BACKEND_URL")
                if nestjs_url:
                    try:
                        import urllib.request, json as _json
                        payload = _json.dumps({
                            "embedding_status": "failed",
                            "embedding_error": error_msg,
                        }).encode()
                        req = urllib.request.Request(
                            f"{nestjs_url.rstrip('/')}/documents/{doc_id}/embedding-status",
                            data=payload,
                            method="PATCH",
                            headers={"Content-Type": "application/json"},
                        )
                        urllib.request.urlopen(req, timeout=5)
                        print(f"[EMBEDDING_FAILED] NestJS notified for document {doc_id}")
                    except Exception as cb_err:
                        print(f"[EMBEDDING_FAILED] NestJS callback failed: {cb_err}")

        background_tasks.add_task(background_embed_and_store, document_id, chunks)

        return {
            "status": "done",
            "embedding_status": "pending",
            "document_id": document_id,
            "filename": file.filename,
            "chunks_count": len(chunks),
            "summary": summary_text,
            "provider_used": generation_model,
            "evaluation": evaluation_result,
        }


    except HTTPException:
        _free_gpu_memory()
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[ERROR] Unexpected error processing document '{file.filename}' (id={document_id}):")
        print(tb)
        _free_gpu_memory()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_file_path):
            os.remove(temp_file_path)

@app.get("/ingest/status/{document_id}")
async def get_ingest_status(document_id: str):
    """
    Poll the real embedding/indexing status for a document.

    Returns one of:
      - { "status": "pending" }               — background task still running
      - { "status": "done" }                  — vectors stored in Pinecone ✓
      - { "status": "embedding_failed",
          "error": "<reason>" }               — Pinecone upsert failed
      - { "status": "unknown" }               — document_id never submitted this session

    NestJS should poll this endpoint a few seconds after receiving the initial
    /ingest 200 OK (which only confirms extraction + summary succeeded).
    """
    info = _get_embedding_status(document_id)
    return {"document_id": document_id, **info}


# ── Request / Response models for regeneration ──────────────────────────────────

class RegenerateSummaryRequest(BaseModel):
    document_id: str
    previous_feedback: str
    previous_summary: str = ""          # the summary text from the last attempt
    attempt_number: int = 2


class RegenerateSummaryResponse(BaseModel):
    status: str
    summary: str
    provider_used: str
    evaluation: dict
    attempt_number: int
    improved_prompt_used: str


def _format_feedback_as_instructions(previous_feedback: str) -> str:
    """
    Convert the judge's evaluation (either a JSON blob or plain text) into
    explicit, human-readable improvement instructions.

    If the feedback is a JSON dict with {criterion: {score, rationale}} pairs,
    we emit:
      - CORRECT (score >= 4): keep and reinforce
      - IMPROVE  (score < 4): explicit fix instruction + rationale
    Otherwise the raw text is used verbatim.
    """
    import json as _json
    try:
        data = _json.loads(previous_feedback)
        if not isinstance(data, dict):
            raise ValueError("not a dict")
    except Exception:
        # Plain-text feedback — use as-is
        return previous_feedback.strip()

    # Criterion display names
    LABELS = {
        "fluency": "Fluidité / qualité linguistique",
        "completeness": "Exhaustivité (sujets couverts)",
        "pedagogical_clarity": "Clarté pédagogique",
        "concept_preservation": "Préservation des concepts clés",
    }

    fixes: list[str] = []
    keeps: list[str] = []

    for criterion, info in data.items():
        if not isinstance(info, dict):
            continue
        score = int(info.get("score") or 0)
        rationale = (info.get("rationale") or "").strip()
        label = LABELS.get(criterion, criterion)

        if score >= 4:
            keeps.append(
                f"  ✓ {label} (score {score}/5) — déjà bien ; "
                f"conserve cet aspect sans le dégrader.\n"
                f"    Raison : {rationale}"
            )
        else:
            fixes.append(
                f"  ✗ {label} (score {score}/5) — À CORRIGER ABSOLUMENT.\n"
                f"    Problème identifié : {rationale}\n"
                f"    Action requise : améliore spécifiquement cet aspect dans la nouvelle version."
            )

    parts: list[str] = []
    if fixes:
        parts.append("POINTS À CORRIGER (priorité haute) :\n" + "\n\n".join(fixes))
    if keeps:
        parts.append("POINTS DÉJÀ CORRECTS (à préserver) :\n" + "\n".join(keeps))

    return "\n\n".join(parts) if parts else previous_feedback.strip()


def _build_improved_prompt(
    chunk_texts: list[str],
    previous_feedback: str,
    previous_summary: str = "",
) -> str:
    """
    Build an improved summary prompt that:
    - Includes the previous summary so the LLM knows what was already written
    - Converts raw JSON judge feedback to human-readable fix instructions
    - Explicitly tells the LLM what to fix vs what to preserve
    - Requires not removing correct content just to shorten
    """
    combined = "\n\n".join(chunk_texts)
    if len(combined) > 12_000:
        combined = combined[:12_000] + "\n\n[… contenu tronqué …]"

    formatted_feedback = _format_feedback_as_instructions(previous_feedback)

    prev_summary_block = ""
    if previous_summary and previous_summary.strip():
        prev = previous_summary.strip()
        if len(prev) > 3000:
            prev = prev[:3000] + "\n[... résumé tronqué ...]"
        prev_summary_block = (
            "Version précédente du résumé (à améliorer, NE PAS copier) :\n"
            "---\n"
            f"{prev}\n"
            "---\n\n"
        )

    return (
        "Tu es un assistant pédagogique expert chargé d'améliorer un résumé pédagogique.\n\n"
        f"{prev_summary_block}"
        "Retour détaillé du juge LLM sur la version précédente :\n"
        "---\n"
        f"{formatted_feedback}\n"
        "---\n\n"
        "INSTRUCTIONS STRICTES :\n"
        "1. Corrige SPÉCIFIQUEMENT les points marqués À CORRIGER ci-dessus.\n"
        "2. Préserve et renforce les points marqués déjà corrects.\n"
        "3. Ne raccourcis PAS le contenu déjà correct — l'exhaustivité est une exigence.\n"
        "4. Assure-toi que tous les concepts clés, définitions et exemples du document sont présents.\n"
        "5. Utilise un français courant, fluide et adapté à un étudiant.\n"
        "6. NE GÉNÈRE AUCUNE réflexion interne, aucune balise <think>, aucun méta-commentaire. Génère UNIQUEMENT le résumé pédagogique rédigé.\n\n"
        "Structure requise :\n"
        "- Une introduction courte présentant le sujet\n"
        "- Les concepts clés expliqués clairement et exhaustivement\n"
        "- Une conclusion synthétique\n\n"
        "Extraits du document source :\n\n"
        f"{combined}\n\n"
        "Résumé pédagogique amélioré :"
    )


@app.post("/regenerate-summary", response_model=RegenerateSummaryResponse)
async def regenerate_summary(
    document_id: str = Form(...),
    previous_feedback: str = Form(""),
    previous_summary: str = Form(""),
    attempt_number: int = Form(2),
    file: UploadFile = File(None)
):
    """
    Regenerate a summary for a document using an improved prompt built from
    the LLM judge's previous feedback.

    Uses cached chunk texts if they exist. Otherwise, chunks the uploaded file on the fly.
    """
    document_id = document_id.strip()
    if not document_id:
        raise HTTPException(status_code=400, detail="document_id is required.")

    # Retrieve cached chunk texts
    chunk_texts = _get_cached_chunks(document_id)
    if not chunk_texts:
        if not file:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"No cached chunks found for document_id='{document_id}'. "
                    "Please upload the source file to regenerate."
                ),
            )
        # Extract and chunk the uploaded file to recreate cache
        print(f"[REGENERATE] Chunks not in cache. Extracting and chunking {file.filename}...")
        file_ext = Path(file.filename).suffix.lower()
        temp_file_path = f"temp_uploads/{document_id}_regen{file_ext}"
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        try:
            elements = extract_document(temp_file_path, file_ext)
            if not elements:
                raise HTTPException(status_code=400, detail="Could not extract any content from the document.")
            chunks = chunk_elements(elements, document_id=document_id)
            chunk_texts = [chunk["text"] for chunk in chunks]
            _cache_chunks(document_id, chunk_texts)
        finally:
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)

    # ── Root MLflow trace for the regeneration pipeline ───────────────────────
    _init_mlflow()
    # Build improved prompt from previous judge feedback + previous summary
    improved_prompt = _build_improved_prompt(
        chunk_texts,
        previous_feedback,
        previous_summary,
    )

    with mlflow.start_span(
        name="summary_regeneration_pipeline",
        attributes={
            "document_id": document_id,
            "attempt_number": attempt_number,
        },
    ) as regen_span:
        regen_span.set_inputs({
            "document_id": document_id,
            "attempt_number": attempt_number,
            "previous_feedback": previous_feedback[:500] if previous_feedback else "",
            "previous_summary_length": len(previous_summary) if previous_summary else 0,
            "prompt": improved_prompt[:2000] + ("..." if len(improved_prompt) > 2000 else ""),
        })

        # Generate new summary using the same LLM fallback chain
        print(f"[REGENERATE] Attempt #{attempt_number} for document {document_id}...")
        t0 = time.time()
        summary_result = generate_summary(
            improved_prompt,
            prompt_name="summary_generation_regenerate",
            prompt_version=str(attempt_number),
        )
        t_gen = time.time() - t0
        print(f"[REGENERATE] Generation: {t_gen:.1f}s")

        if summary_result.get("invalid_content"):
            raise HTTPException(
                status_code=422,
                detail=summary_result.get("message", INVALID_CONTENT_MESSAGE),
            )

        summary_text = summary_result["summary"]
        generation_model = summary_result.get("provider_used", "unknown")
        token_usage = summary_result.get("token_usage") or {}

        regen_span.set_outputs({
            "status": "done",
            "summary": summary_text[:2000] + ("..." if len(summary_text) > 2000 else ""),
            "generation_model": generation_model,
            "generation_time_s": round(t_gen, 1),
            "prompt_tokens": token_usage.get("prompt_tokens", 0),
            "completion_tokens": token_usage.get("completion_tokens", 0),
            "total_tokens": token_usage.get("total_tokens", 0),
            "estimated_cost_usd": token_usage.get("estimated_cost_usd", 0.0),
        })

    try:
        mlflow.flush_trace_async_logging()
    except Exception:
        pass

    # Evaluate the NEW summary outside span context so MLflow Run logs cleanly
    evaluation_result = evaluate_summary(
        document_text="\n\n".join(chunk_texts),
        summary=summary_text,
        document_id=document_id,
        attempt_number=attempt_number,
        generation_model=generation_model,
        token_usage=token_usage,
        trace_id=summary_result.get("trace_id"),
    )

    print(
        f"[REGENERATE] Attempt #{attempt_number} complete — "
        f"score: {evaluation_result['final_score']}, "
        f"judge: {evaluation_result['selected_model']}, "
        f"generator: {generation_model}"
    )

    return RegenerateSummaryResponse(
        status="done",
        summary=summary_text,
        provider_used=generation_model,
        evaluation=evaluation_result,
        attempt_number=attempt_number,
        improved_prompt_used=improved_prompt,
    )


# ── Podcast script generation ────────────────────────────────────────────────────

class GenerateScriptRequest(BaseModel):
    course_id: str
    summary: str = ""
    previous_script: list[dict] | None = None
    correction_prompt: str | None = None


@app.post("/podcast/generate-script")
async def generate_podcast_script(request: GenerateScriptRequest):
    """
    Generate or refine a professor/student dialogue script.

    Body fields:
        course_id         : Identifier of the course.
        summary           : The validated pedagogical summary text.
        previous_script   : Optional list of existing dialogue turns.
        correction_prompt : Optional improvement prompt string.
    """
    course_id = (request.course_id or "").strip()
    summary   = (request.summary   or "").strip()

    if not request.previous_script and not summary:
        raise HTTPException(
            status_code=400,
            detail="Un résumé ou un script existant est requis pour générer le dialogue.",
        )

    try:
        result = generate_dialogue_script(
            summary=summary,
            previous_script=request.previous_script,
            correction_prompt=request.correction_prompt,
        )
    except Exception as exc:
        import traceback
        print(f"[PODCAST] Unexpected error for course {course_id}: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))

    if result.get("error"):
        raise HTTPException(status_code=422, detail=result["error"])

    return {
        "course_id": course_id,
        "script": result["script"],
        "provider_used": result.get("provider_used"),
        "token_usage": result.get("token_usage", {}),
    }

class GenerateAudioRequest(BaseModel):
    course_id: str
    script: list[dict]

@app.post("/podcast/generate-audio")
async def generate_audio_endpoint(request: GenerateAudioRequest):
    """
    Generate audio for a podcast script and save it to the backend's uploads folder.
    """
    course_id = (request.course_id or "").strip()
    if not request.script or not course_id:
        raise HTTPException(status_code=400, detail="course_id and script are required.")
    
    try:
        audio_url = await generate_podcast_audio(request.script, course_id)
        return {"course_id": course_id, "audio_url": audio_url}
    except Exception as exc:
        import traceback
        print(f"[PODCAST AUDIO] Error for course {course_id}: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))

class PodcastAskRequest(BaseModel):
    question: str
    transcript_so_far: str
    pause_position_s: float = 0.0

@app.post("/podcast/{course_id}/ask")
async def podcast_ask_endpoint(course_id: str, request: PodcastAskRequest):
    """
    Answer a student's question during the podcast using RAG.
    """
    question = (request.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required.")
        
    try:
        req_id = str(uuid.uuid4())[:8]
        print(f"[PODCAST RAG] [{req_id}] Answering question for course {course_id}...")
        result = await asyncio.to_thread(
            rag_answer,
            question=question,
            document_id=course_id,
            transcript_context=request.transcript_so_far
        )
        if result.get("answer"):
            try:
                rag_audio_url = await generate_rag_audio(result["answer"], course_id, req_id)
                result["audio_url"] = rag_audio_url
            except Exception as audio_err:
                print(f"[PODCAST RAG] [{req_id}] Warning: TTS audio generation failed: {audio_err}")
                result["audio_url"] = None
        return result
    except Exception as exc:
        import traceback
        print(f"[PODCAST RAG] Error for course {course_id}: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── GPU helpers ─────────────────────────────────────────────────────────────────

def _free_gpu_memory() -> None:
    """Force PyTorch to release all un-used cached GPU memory blocks."""
    if _TORCH_AVAILABLE and torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()
        print("[GPU] torch.cuda.empty_cache() called — unused cached blocks released.")


def _log_vram(label: str = "") -> None:
    """Log current GPU VRAM usage (allocated and reserved) in GB."""
    if _TORCH_AVAILABLE and torch is not None and torch.cuda.is_available():
        allocated_gb = torch.cuda.memory_allocated() / 1024 ** 3
        reserved_gb  = torch.cuda.memory_reserved()  / 1024 ** 3
        print(
            f"[VRAM] {label} — allocated: {allocated_gb:.3f} GB "
            f"| reserved: {reserved_gb:.3f} GB"
        )
    else:
        print(f"[VRAM] {label} — CUDA not available, running on CPU.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
# Reload trigger: TTS NoAudioReceived fix & segment validation retry logic added





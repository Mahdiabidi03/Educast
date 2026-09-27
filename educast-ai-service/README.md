# EduCast AI Service — FastAPI

Microservice Python qui traite les documents pédagogiques : extraction, résumé, évaluation, régénération et génération du script de dialogue podcast.

## Ce qui est implémenté

| Fonctionnalité | Endpoint | Module |
|---------------|----------|--------|
| Ingestion document → résumé + évaluation | `POST /ingest` | `main.py` |
| Statut embedding (polling) | `GET /ingest/status/{document_id}` | `main.py` |
| Régénération guidée du résumé | `POST /regenerate-summary` | `main.py` |
| Génération script dialogue podcast | `POST /podcast/generate-script` | `main.py` + `services/dialogue.py` |

## Pipeline principal

```
Upload → extraction (Docling + fallback) → chunking → LLM fallback chain → résumé
    → LLM-as-a-Judge (évaluation) → [optionnel: régénération guidée × 2]
    → Pinecone (embeddings, background)
    → [sur demande] dialogue script: résumé → LLM → JSON [{ speaker, text }, ...]
```

## Modules

| Fichier | Rôle |
|---------|------|
| `services/extraction.py` | Docling + fallback PyMuPDF/python-pptx/python-docx |
| `services/chunking.py` | Découpage section-aware avec préservation des tableaux |
| `services/embedding.py` | Génération d'embeddings 384 dimensions |
| `services/vector_store.py` | Index Pinecone + upsert |
| `services/llm_fallback.py` | Chaîne de fallback LLM multi-fournisseurs + MLflow |
| `services/evaluation.py` | LLM-as-a-Judge : score /100 + 4 critères + MLflow |
| `services/dialogue.py` | Script dialogue professeur/étudiant depuis un résumé |
| `main.py` | Orchestration FastAPI, endpoints, cache chunks, GPU utils |

## Chaîne de fallback LLM

L'ordre de tentative est le même pour toutes les tâches (résumé, régénération, dialogue) :

1. **Groq API** (llama-3.1-8b-instant) — priorité : vitesse + coût minimal
2. **Mistral API** (mistral-small-latest)
3. **Google Gemini** (gemini-1.5-flash)
4. **Hugging Face** Inference API (mistralai/Mistral-7B-Instruct-v0.3)
5. **Ollama local** (llama3.2) — fallback ultime, gratuit

## LLM-as-a-Judge

Chaque résumé généré est évalué automatiquement par un second LLM (lui aussi soumis à la chaîne de fallback). L'évaluation produit :
- un score global **/100**
- 4 critères notés **/5** : `fluency`, `completeness`, `pedagogical_clarity`, `concept_preservation`
- un `rationale` textuel par critère

Le résultat est stocké dans `resumeAttempts[].evaluationData` en MongoDB et tracé dans MLflow.

## Workflow de régénération

Si le score du juge est insuffisant, le frontend peut demander une régénération :
1. Le retour du juge (JSON critères+scores+rationale) est envoyé au service.
2. `_format_feedback_as_instructions()` le convertit en instructions humaines (✗ à corriger / ✓ à préserver).
3. Un prompt amélioré est construit avec la version précédente et les instructions.
4. Le LLM génère un résumé amélioré, évalué à nouveau.
5. Jusqu'à 3 tentatives sont enregistrées dans `resumeAttempts`.

## Génération du script de dialogue (nouveau)

`POST /podcast/generate-script`

```json
// Request
{ "course_id": "abc123", "summary": "Le résumé pédagogique validé..." }

// Response
{
  "course_id": "abc123",
  "script": [
    { "speaker": "professeur", "text": "Bonjour, aujourd'hui..." },
    { "speaker": "etudiant",   "text": "D'accord, mais..." }
  ],
  "provider_used": "Groq API",
  "token_usage": { "prompt_tokens": 1200, "completion_tokens": 800, ... }
}
```

Le module `services/dialogue.py` réutilise exactement `generate_summary()` (chaîne de fallback LLM) — seul le prompt change. Le prompt demande au LLM de répondre **uniquement** avec un tableau JSON valide. Trois stratégies de parsing sont tentées en cascade (parse direct → regex → fallback gracieux).

## MLflow Tracing

Chaque appel LLM est tracé dans MLflow avec :
- **Span racine** : pipeline complet (timings, inputs, outputs)
- **Child spans** : un par fournisseur tenté (tokens, coût, modèle)
- **Prompt Registry** : chaque prompt est versionné et lié à la trace
- **Tags** : `mlflow.trace.cost`, `mlflow.trace.tokenUsage` pour les widgets Overview

Interface MLflow disponible sur `http://localhost:5000` (lancer avec `mlflow ui --backend-store-uri sqlite:///mlflow.db`).

## Variables d'environnement

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
GROQ_API_KEY=...
MISTRAL_API_KEY=...
GEMINI_API_KEY=...
HF_API_KEY=...
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=educast-index
MLFLOW_TRACKING_URI=sqlite:///mlflow.db
MLFLOW_EXPERIMENT_NAME=Educast Summary Evaluation
NESTJS_BACKEND_URL=http://localhost:3000
```

## Lancement

```bash
cd educast-ai-service
python -m venv venv
.\venv\Scripts\activate     # Windows PowerShell
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Scripts de validation

```bash
python check_gpu.py            # diagnostic GPU CUDA
python test_table_extraction.py
python test_fallback.py
```

## Prochaine étape envisagée

Génération audio TTS du script podcast :
- `services/tts.py` : edge-tts ou gTTS, une piste audio par tour de parole
- ffmpeg pour concaténer les clips en un MP3 final
- `POST /podcast/generate-audio` : prend le `course_id`, génère l'audio, retourne le chemin
- `podcast.audioUrl` mis à jour en MongoDB via NestJS

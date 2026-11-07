# EduCast

Plateforme d'apprentissage qui transforme des cours (PDF, PPTX, DOCX) en résumés, en podcasts à deux voix et en chat vocal avec un assistant RAG.

Le dépôt contient trois services :

- `educast-backend` : API REST en NestJS (utilisateurs, authentification, documents, cours)
- `educast-ai-service` : microservice FastAPI (extraction, résumé, évaluation, scripts de dialogue, synthèse vocale)
- `educast-frontend` : application React/Vite

## Fonctionnement

### Backend (NestJS)

- Authentification JWT avec deux rôles : `admin` et `etudiant`
- Inscription avec vérification de l'email par un code à 6 chiffres, valable 24h, envoyé par Gmail SMTP (nodemailer)
- Un utilisateur non vérifié ne peut pas se connecter (la réponse contient `requiresVerification: true`)
- Les comptes de démonstration sont créés déjà vérifiés
- PostgreSQL (TypeORM) pour les utilisateurs, matières et documents
- MongoDB (Mongoose) pour les cours partagés, les résumés personnels (`ownerId`), les empreintes SHA-256 (`fileHash`) et l'historique des chats (`ChatMessage`)
- Si un fichier a déjà été importé (même hash), le résumé, le script et l'audio sont copiés pour le nouvel étudiant sans régénération
- L'entrée MongoDB est créée dès le début de l'upload, ce qui permet de suivre la génération même si l'utilisateur change d'onglet
- Régénération du script avec un prompt de correction (`correctionPrompt`)

Endpoints d'authentification :

| Méthode | Route | Corps | Rôle |
|---|---|---|---|
| POST | `/auth/register` | | Crée le compte et envoie le code |
| POST | `/auth/verify-email` | `{ email, code }` | Vérifie le code et renvoie un JWT |
| POST | `/auth/resend-verification` | `{ email }` | Génère un nouveau code |
| POST | `/auth/login` | | Connexion |

### AI Service (FastAPI)

- Extraction avec Docling, repli sur PyMuPDF, python-pptx et python-docx en cas d'échec
- Résumé par LLM avec une chaîne de secours, dans cet ordre :
  1. Groq (`openai/gpt-oss-120b`)
  2. Mistral (`mistral-small-latest`, timeout de 60 s)
  3. Gemini (`gemini-1.5-flash`)
  4. Hugging Face (`mistralai/Mistral-7B-Instruct-v0.3`)
  5. Ollama en local (`llama3.2`)
- Évaluation du résumé par LLM-as-a-Judge (score sur 100 avec critères détaillés)
- Régénération guidée du résumé (3 tentatives maximum) et du script de dialogue, en tenant compte du prompt de correction et du script précédent
- Synthèse vocale avec edge-tts : `fr-FR-HenriNeural` pour le Professeur, `fr-FR-DeniseNeural` pour l'Étudiant
- `_clean_text_for_tts` convertit le LaTeX, les formules, le code et le markdown en texte lisible à l'oral
- Les réponses du chat RAG sont aussi synthétisées (`uploads/rag/{course_id}_{rag_id}.mp3`), et le prompt impose de répondre uniquement en français
- Embeddings et stockage dans Pinecone pour le RAG
- Suivi MLflow : tokens, coût, versions de prompt

### Frontend (React/Vite)

- Page de connexion avec accès rapide aux comptes de démonstration
- Inscription réservée au rôle Étudiant
- Saisie du code de vérification sur la même page (6 champs, copier-coller possible, bouton de renvoi)
- Lecteur audio `CustomAudioBar` utilisé pour le podcast et pour chaque réponse vocale : lecture/pause, barre de progression, vitesse (0.75x à 2.0x), téléchargement MP3
- Quand le professeur répond à l'oral, le podcast se met en pause puis reprend à la fin de la réponse
- Historique du chat conservé par utilisateur
- Mode sombre et mode clair

## Comptes de démonstration

Créés au premier lancement du backend :

| Rôle | Email | Mot de passe |
|---|---|---|
| Administrateur (M. El Amari) | `admin@educast.fr` | `admin123` |
| Étudiant 1 | `etudiant@educast.fr` | `etudiant123` |
| Étudiant 2 | `etudiant2@educast.fr` | `etudiant123` |

L'administrateur a accès à toute la bibliothèque en CRUD, les étudiants à leur espace personnel.

## Prérequis

- Node.js 18 ou plus
- Python 3.9 ou plus, avec PyTorch et edge-tts
- PostgreSQL et MongoDB
- Un index Pinecone de dimension 384
- Un compte Gmail avec un mot de passe d'application (https://myaccount.google.com/apppasswords)
- Ollama avec `llama3.2` (facultatif si des clés API sont renseignées)

## Configuration

### Backend (`educast-backend/.env`)

```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/educast
MONGODB_URI=mongodb://127.0.0.1:27017/educast
FASTAPI_URL=http://localhost:8000

JWT_SECRET=change-me

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
SMTP_FROM_NAME=EduCast

FRONTEND_URL=http://localhost:5173
```

Un fichier `.env.example` est fourni.

### AI Service (`educast-ai-service/.env`)

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-120b
MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-small-latest
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash
HF_API_KEY=...
HF_MODEL=mistralai/Mistral-7B-Instruct-v0.3
PINECONE_API_KEY=...
PINECONE_INDEX_NAME=educast
MLFLOW_TRACKING_URI=sqlite:///mlflow.db
MLFLOW_EXPERIMENT_NAME=Educast Summary Evaluation
NESTJS_BACKEND_URL=http://localhost:3000
```

## Lancement en local

Démarrer d'abord PostgreSQL, MongoDB et (si besoin) Ollama, puis :

**1. AI Service**

```bash
cd educast-ai-service
python -m venv venv
.\venv\Scripts\activate    # Windows PowerShell
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

**2. MLflow (facultatif)**

```bash
cd educast-ai-service
mlflow ui --backend-store-uri sqlite:///mlflow.db --port 5000 --workers 1
```

Interface sur http://localhost:5000.

**3. Backend**

```bash
cd educast-backend
npm install --legacy-peer-deps
npm run start:dev
```

**4. Frontend**

```bash
cd educast-frontend
npm install
npm run dev
```

## Parcours d'un document

```
Inscription
  POST /auth/register -> compte avec emailVerified = false
  -> code à 6 chiffres envoyé par mail (valable 24h)
  POST /auth/verify-email { email, code } -> JWT, connexion automatique
  (code expiré : POST /auth/resend-verification)

Upload (PDF / PPTX / DOCX)
  -> hash SHA-256
  -> doublon : copie du résumé, du script et de l'audio
  -> sinon : cours "pending" dans MongoDB, puis POST /ingest (FastAPI)
  -> extraction Docling, résumé LLM, évaluation LLM-as-a-Judge

Podcast
  -> /courses/:id/generate-podcast-script (avec correctionPrompt si besoin)
  -> /courses/:id/generate-podcast-audio -> /podcast/generate-audio (FastAPI)
  -> MP3 enregistré dans uploads/podcasts/{id}.mp3

Chat RAG
  -> /courses/:id/podcast-ask -> /podcast/{course_id}/ask (FastAPI)
  -> recherche Pinecone + réponse du LLM en français
  -> réponse vocale uploads/rag/{course_id}_{rag_id}.mp3, lue automatiquement
  -> messages enregistrés dans MongoDB (ChatMessage)
```

## Structure des fichiers principaux

```
educast-backend/
├── src/
│   ├── auth/
│   │   ├── user.entity.ts       # emailVerified, verificationToken, verificationTokenExpiry
│   │   ├── auth.service.ts      # register, login, verifyEmail, resendVerificationEmail
│   │   ├── auth.controller.ts
│   │   └── auth.module.ts
│   ├── mail/
│   │   ├── mail.service.ts      # envoi SMTP + template du code
│   │   └── mail.module.ts
│   ├── courses/                 # cours MongoDB, chat RAG, podcast
│   └── documents/               # upload, extraction, résumé via FastAPI
├── .env
└── .env.example

educast-frontend/
└── src/
    ├── Login.tsx                # connexion, inscription, saisie du code
    └── App.tsx                  # routing (bibliothèque / résumé rapide)

educast-ai-service/
├── services/
│   ├── llm_fallback.py          # Groq -> Mistral -> Gemini -> HF -> Ollama
│   └── rag.py                   # chat RAG, réponses en français
└── .env
```

## Docker

### Dépendances Python : GPU en local, CPU dans Docker

| Contexte | Fichier | Torch | Latence TTS / inférence |
|---|---|---|---|
| Local (GPU NVIDIA) | `requirements.txt` | `torch+cu121` | environ 1 à 3 s |
| Docker Compose (sans GPU) | `requirements-docker.txt` | `torch` CPU | environ 10 à 30 s |

Le Dockerfile de `ai-service` utilise `requirements-docker.txt`, pour ne pas essayer d'installer les wheels CUDA sans GPU.

### Fichiers d'environnement

| Fichier | Usage | Versionné |
|---|---|---|
| `.env` | développement local | non (`.gitignore`) |
| `.env.docker` | Docker Compose | non (`.gitignore`) |
| `.env.example` | modèle | oui |

Avant le premier lancement :

```bash
cp educast-backend/.env.example educast-backend/.env.docker
cp educast-ai-service/.env.example educast-ai-service/.env.docker
```

Dans `.env.docker`, remplacer `localhost` par le nom du service Docker :

| Variable | Local | Docker |
|---|---|---|
| `DATABASE_URL` | `@localhost:5432` | `@postgres:5432` |
| `MONGODB_URI` | `mongodb://localhost:27017/...` | `mongodb://mongodb:27017/...` |
| `FASTAPI_URL` | `http://localhost:8000` | `http://ai-service:8000` |
| `MLFLOW_TRACKING_URI` | `http://localhost:5000` | `http://mlflow:5000` |
| `NESTJS_BACKEND_URL` | `http://localhost:3000` | `http://backend:3000` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` |

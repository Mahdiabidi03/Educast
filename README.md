# EduCast — Vue d'ensemble du dépôt

Ce dépôt regroupe trois services complémentaires :

- un backend NestJS pour l'API REST, la gestion des utilisateurs, la vérification d'email et la persistance des documents,
- un microservice FastAPI pour l'extraction, le résumé pédagogique, l'évaluation LLM, la génération de scripts et la synthèse vocale (edge-tts),
- un frontend React/Vite pour l'upload, la bibliothèque de cours, les résumés, l'évaluation, le dialogue podcast interactif et la vérification d'email.

## Services présents

- **Backend** : [educast-backend](educast-backend)
  - API REST NestJS avec authentification JWT (`educast_token` / `educast_user`)
  - Gestion des utilisateurs et rôles (`admin` vs `etudiant`)
  - **Système de vérification d'email par code à 6 chiffres** :
    - À l'inscription, un code aléatoire à 6 chiffres est généré avec une expiration de 24h
    - Email premium envoyé via Gmail SMTP (`nodemailer`) avec le code affiché dans des cases individuelles stylisées
    - Endpoint `POST /auth/verify-email` `{ email, code }` — vérifie le code, marque `emailVerified = true`, retourne un JWT
    - Endpoint `POST /auth/resend-verification` — génère un nouveau code et renvoie l'email
    - Les comptes de démonstration (`admin`, `etudiant`, `etudiant2`) sont automatiquement marqués comme vérifiés
    - Les utilisateurs non vérifiés ne peuvent pas se connecter (retour `requiresVerification: true`)
  - Stockage PostgreSQL (TypeORM) : documents, matières, utilisateurs (`emailVerified`, `verificationToken`, `verificationTokenExpiry`)
  - Stockage MongoDB (Mongoose) : cours partagés de la bibliothèque, résumés rapides personnels par étudiant (`ownerId`), empreintes SHA-256 (`fileHash`) et historique des chats (`ChatMessage`)
  - Détection automatique de doublons par empreinte SHA-256 du contenu pour réutilisation instantanée du résumé et du podcast
  - Création immédiate de l'entrée MongoDB dès le début du téléversement avec persistance et suivi de la génération lors du changement d'onglet
  - Endpoints sécurisés pour la régénération de scripts avec invites de correction (`correctionPrompt`) et la persistance du chat par utilisateur (`GET /courses/:id/chat`)

- **AI Service** : [educast-ai-service](educast-ai-service)
  - Extraction de documents via Docling (primaire) avec gestionnaire de sémaphore d'accès concurrentiel
  - Fallback vers PyMuPDF / python-pptx / python-docx si Docling échoue
  - Résumé pédagogique via une chaîne de fallback LLM durcie :
    1. **Groq API** (`openai/gpt-oss-120b`)
    2. **Mistral API** (`mistral-small-latest` — timeout 60s)
    3. **Google Gemini** (`gemini-1.5-flash`)
    4. **Hugging Face Inference API** (`mistralai/Mistral-7B-Instruct-v0.3`)
    5. **Ollama local** (`llama3.2`)
  - Évaluation automatique par LLM-as-a-Judge avec score /100 et critères détaillés
  - Workflow de régénération guidée de résumé (jusqu'à 3 tentatives) et régénération de script dialogue avec prise en compte du prompt de correction et du script précédent
  - Synthèse vocale multilingue via **edge-tts** :
    - Voix masculine (`fr-FR-HenriNeural`) pour le Professeur et féminine (`fr-FR-DeniseNeural`) pour l'Étudiant
    - Normalisation complète du texte pour TTS (`_clean_text_for_tts`) transformant le LaTeX, les maths, les blocs de code et le markdown en français oral naturel
    - Synthèse vocale à la volée des réponses RAG du professeur dans `/uploads/rag/{course_id}_{rag_id}.mp3` avec consigne stricte de réponse **EXCLUSIVEMENT en Français**
  - Traçage MLflow complet (tokens, coût, versions de prompt, spans imbriqués)
  - Embeddings + stockage Pinecone pour le RAG

- **Frontend** : [educast-frontend](educast-frontend)
  - Écran de connexion avec sélecteur rapide de comptes de démonstration (`Admin`, `Étudiant 1`, `Étudiant 2`)
  - Inscription sécurisée restreinte au rôle Étudiant
  - **Vérification d'email intégrée à la page de connexion** :
    - Après inscription, affichage inline de 6 champs de saisie pour le code (auto-focus, support copier-coller)
    - Bouton de renvoi du code et retour à la connexion
    - Vérification instantanée et connexion automatique après validation
  - Lecteur audio sur-mesure (`CustomAudioBar`) identique pour le podcast principal et **pour chaque réponse vocale du chat** :
    - Bouton Lecture/Pause ▶ / ⏸
    - Barre de progression scrubable avec affichage du temps (`mm:ss / mm:ss`)
    - Sélecteur de vitesse de lecture (`0.75x` à `2.0x`)
    - Bouton de téléchargement MP3 direct
  - Démarrage automatique des réponses audio RAG avec pause du podcast principal et **reprise automatique** à la fin de la réponse du professeur
  - Défilement automatique vers le haut (*Scroll to Top*) à la finalisation du podcast
  - Persistance illimitée de l'historique du chat interactif par utilisateur
  - Interface épurée et adaptative (mode sombre/clair)

## Comptes de démonstration créés automatiquement

À l'initialisation du backend, trois comptes sont semés dans PostgreSQL (tous marqués `emailVerified = true`) :
- **Administrateur** : `admin@educast.fr` / `admin123` (M. El Amari — Accès complet CRUD Bibliothèque)
- **Étudiant Demo 1** : `etudiant@educast.fr` / `etudiant123` (Étudiant Demo 1 — Espace personnel)
- **Étudiant Demo 2** : `etudiant2@educast.fr` / `etudiant123` (Étudiant Demo 2 — Espace personnel)

> Les comptes existants créés avant le déploiement du système de vérification peuvent se connecter sans vérification email.

## Prérequis

1. Node.js 18+ (20+ LTS fortement recommandé)
2. Python 3.9+ avec PyTorch et edge-tts
3. PostgreSQL en cours d'exécution
4. MongoDB en cours d'exécution
5. Ollama avec un modèle disponible (`llama3.2`) — optionnel si des clés API cloud sont configurées
6. Pinecone avec un index configuré (384 dimensions)
7. **Compte Gmail avec mot de passe d'application** activé (pour l'envoi d'emails de vérification)
   - Générer un mot de passe d'application : https://myaccount.google.com/apppasswords

## Variables d'environnement

### Backend (`educast-backend/.env`)
```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/educast
MONGODB_URI=mongodb://127.0.0.1:27017/educast
FASTAPI_URL=http://localhost:8000

# JWT
JWT_SECRET=your-super-secret-jwt-key

# Email SMTP (Gmail)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_gmail@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # Gmail App Password
SMTP_FROM_NAME=EduCast

# URL du frontend (incluse dans le lien de vérification)
FRONTEND_URL=http://localhost:5173
```

> Un fichier `educast-backend/.env.example` est fourni avec toutes les variables documentées.

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

## Ordre de lancement recommandé

### 1. Bases de données et services externes
- Démarrer PostgreSQL
- Démarrer MongoDB
- Démarrer Ollama (optionnel)

### 2. Microservice AI (FastAPI)
```bash
cd educast-ai-service
python -m venv venv
.\venv\Scripts\activate  # Windows PowerShell
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 3. MLflow UI (optionnel — tableau de bord traces/coûts)
```bash
cd educast-ai-service
mlflow ui --backend-store-uri sqlite:///mlflow.db --port 5000 --workers 1
# Accès : http://localhost:5000
```

### 4. Backend NestJS
```bash
cd educast-backend
npm install --legacy-peer-deps
npm run start:dev
```

### 5. Frontend React/Vite
```bash
cd educast-frontend
npm install
npm run dev
```

## Workflow complet — de l'inscription au chat podcast RAG

```
Inscription nouvel utilisateur
    → POST /auth/register
    → Compte créé avec emailVerified = false
    → Code aléatoire à 6 chiffres généré (expiration 24h)
    → Email HTML premium envoyé via Gmail SMTP avec le code
    → Frontend affiche les 6 champs de saisie inline (même page)

Vérification du compte
    → L'utilisateur saisit le code reçu par email
    → POST /auth/verify-email { email, code }
    → emailVerified = true, code effacé
    → JWT retourné → connexion automatique

[Si code expiré] Renvoi du code
    → POST /auth/resend-verification { email }
    → Nouveau code généré + email renvoyé

Upload document (PDF / PPTX / DOCX)
    → Calcul hash SHA-256 (fileHash)
    → Si doublon trouvé : Copie indépendante immédiate du résumé, script et audio pour le nouvel étudiant
    → Si nouveau : Création immédiate du cours 'pending' dans MongoDB + POST /ingest (FastAPI)
    → Extraction Docling + Résumé LLM + Évaluation LLM-as-a-Judge
    → MongoDB: resume.text + resumeAttempts[0]

[Optionnel] Régénération du résumé / script
    → /courses/:id/generate-podcast-script avec correctionPrompt et previousScript
    → Nouveau dialogue professeur/étudiant généré par le LLM

Synthèse vocale du podcast (edge-tts)
    → /courses/:id/generate-podcast-audio (NestJS)
    → /podcast/generate-audio (FastAPI) — voix fr-FR-HenriNeural et fr-FR-DeniseNeural
    → Sauvegarde MP3 sur disque (uploads/podcasts/{id}.mp3)

Chat RAG interactif & réponses vocales
    → L'étudiant pose une question dans le chat
    → /courses/:id/podcast-ask (NestJS) → /podcast/{course_id}/ask (FastAPI)
    → Recherche Pinecone + Réponse LLM (Stricte consigne en Français)
    → Synthèse de la réponse du prof en audio (uploads/rag/{course_id}_{rag_id}.mp3)
    → Auto-play de la réponse du prof avec le lecteur CustomAudioBar
    → Reprise automatique du podcast principal à la fin de la réponse
    → Persistance permanente des messages dans MongoDB (ChatMessage)
```

## Architecture des fichiers clés

```
educast-backend/
├── src/
│   ├── auth/
│   │   ├── user.entity.ts          # emailVerified, verificationToken, verificationTokenExpiry
│   │   ├── auth.service.ts         # register, login, verifyEmail, resendVerificationEmail
│   │   ├── auth.controller.ts      # POST /register, POST /login, POST /verify-email, POST /resend-verification
│   │   └── auth.module.ts          # Imports MailModule
│   ├── mail/
│   │   ├── mail.service.ts         # Envoi Gmail SMTP via nodemailer + template HTML code à 6 chiffres
│   │   └── mail.module.ts
│   ├── courses/                    # MongoDB courses, chat RAG, podcast
│   └── documents/                  # Upload, extraction, résumé via FastAPI
├── .env                            # Variables d'environnement (SMTP inclus)
└── .env.example                    # Template documenté

educast-frontend/
├── src/
│   ├── Login.tsx                   # Connexion + inscription + saisie inline du code à 6 chiffres
│   └── App.tsx                     # Routing principal (bibliothèque / résumé rapide)

educast-ai-service/
├── services/
│   ├── llm_fallback.py             # Chaîne LLM : Groq → Mistral → Gemini → HF → Ollama
│   └── rag.py                      # Chat RAG avec consigne French-only
└── .env                            # Clés API et modèles LLM actifs
```

---

## Déploiement Docker

### GPU (local) vs CPU (Docker) — distinction importante

| Contexte | Fichier requirements | Torch | Latence TTS / inférence |
|---|---|---|---|
| **Développement local** (GPU NVIDIA) | `requirements.txt` | `torch+cu121` (CUDA) | ~1–3 s |
| **Docker Compose** (pas de GPU) | `requirements-docker.txt` | `torch` (CPU standard) | ~10–30 s |

Le Dockerfile du `ai-service` utilise `requirements-docker.txt` (CPU uniquement) afin d'éviter une tentative d'installation de wheels CUDA dans un environnement sans GPU.

### Fichiers d'environnement

| Fichier | Usage | Commité sur Git ? |
|---|---|---|
| `.env` | Développement local — `localhost` partout | ❌ Non (dans `.gitignore`) |
| `.env.docker` | Docker Compose — noms de services Docker | ❌ Non (dans `.gitignore`) |
| `.env.example` | Template vide à documenter | ✅ Oui |

Avant de lancer Docker, copier et remplir les fichiers `.env.docker` :

```bash
# Backend
cp educast-backend/.env.example educast-backend/.env.docker
# AI Service
cp educast-ai-service/.env.example educast-ai-service/.env.docker
```

Dans `.env.docker`, remplacer `localhost` par les noms de services Docker :

| Variable | Valeur locale | Valeur Docker |
|---|---|---|
| `DATABASE_URL` | `...@localhost:5432/...` | `...@postgres:5432/...` |
| `MONGODB_URI` | `mongodb://localhost:27017/...` | `mongodb://mongodb:27017/...` |
| `FASTAPI_URL` | `http://localhost:8000` | `http://ai-service:8000` |
| `MLFLOW_TRACKING_URI` | `http://localhost:5000` | `http://mlflow:5000` |
| `NESTJS_BACKEND_URL` | `http://localhost:3000` | `http://backend:3000` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | `http://host.docker.internal:11434` |

### Lancement avec Docker Compose

```bash
# Depuis la racine du dépôt
docker compose up -d

# Vérifier que tous les services sont démarrés
docker compose ps

# Consulter les logs d'un service en particulier
docker compose logs -f backend
docker compose logs -f ai-service
```

### Accès aux services une fois démarrés

| Service | URL |
|---|---|
| Frontend (React) | http://localhost |
| Backend API (NestJS) | http://localhost:3000 |
| AI Service (FastAPI) | http://localhost:8000/docs |
| MLflow UI | http://localhost:5000 |
| PostgreSQL | localhost:5432 |
| MongoDB | localhost:27017 |

### Arrêt et nettoyage

```bash
# Arrêter les conteneurs (volumes conservés)
docker compose down

# Arrêter ET supprimer les volumes de données
docker compose down -v
```

> **Note Ollama** : Ollama tourne sur la machine hôte, pas dans Docker. Dans `.env.docker`, utiliser `OLLAMA_BASE_URL=http://host.docker.internal:11434` pour que le conteneur `ai-service` puisse l'atteindre.

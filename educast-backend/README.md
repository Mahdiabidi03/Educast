# EduCast Backend — NestJS API

REST API backend de la plateforme **EduCast**. Gère les documents, les cours, les matières et orchestre les appels vers le microservice AI FastAPI.

---

## Tech Stack

| Couche | Technologie |
|--------|-------------|
| Framework | NestJS 11 |
| Langage | TypeScript |
| ORM (PostgreSQL) | TypeORM |
| ODM (MongoDB) | Mongoose + @nestjs/mongoose |
| Bases de données | PostgreSQL (matières) + MongoDB (cours, résumés, podcasts) |
| Upload | Multer |
| Config | @nestjs/config + `.env` |

---

## Prérequis

- **Node.js** ≥ 18 (v20+ recommandé)
- **PostgreSQL** en cours d'exécution
- **MongoDB** en cours d'exécution
- **npm** ≥ 9

---

## Installation

```bash
cd educast-backend
npm install
cp .env.example .env   # puis éditer les valeurs
```

### Variables d'environnement (`.env`)

| Variable | Description | Défaut |
|----------|-------------|--------|
| `DATABASE_URL` | Chaîne de connexion PostgreSQL | `postgres://postgres:postgres@localhost:5432/educast` |
| `MONGODB_URI` | URI MongoDB | `mongodb://127.0.0.1:27017/educast` |
| `FASTAPI_URL` | URL du microservice AI | `http://localhost:8000` |
| `PORT` | Port HTTP | `3000` |

---

## Lancement

```bash
npm run start:dev   # développement (watch mode)
npm run build && npm run start:prod   # production
```

API disponible sur **http://localhost:3000**.

---

## Endpoints

### Documents

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/documents/upload` | Upload d'un fichier (PDF / PPTX / DOCX) |
| `GET` | `/documents/:id/summary` | Statut + résumé d'un document |
| `PATCH` | `/documents/:id/embedding-status` | Mise à jour du statut d'embedding (callback depuis FastAPI) |

### Matières

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/matieres` | Liste de toutes les matières |
| `POST` | `/matieres` | Créer une matière |
| `PATCH` | `/matieres/:id` | Renommer une matière |
| `DELETE` | `/matieres/:id` | Supprimer une matière |

### Cours

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/courses` | Liste des cours (filtre optionnel `?matiere=<id>`) |
| `GET` | `/courses/:id` | Détail d'un cours |
| `POST` | `/courses` | Créer un cours |
| `PATCH` | `/courses/:id` | Mettre à jour un cours |
| `DELETE` | `/courses/:id` | Supprimer un cours |
| `POST` | `/courses/:id/generate-summary` | Générer le résumé (appel FastAPI `/ingest`) |
| `POST` | `/courses/:id/regenerate-summary` | Régénérer avec feedback du juge (appel FastAPI `/regenerate-summary`) |
| `POST` | `/courses/:id/generate-podcast-script` | Générer le script de dialogue podcast (appel FastAPI `/podcast/generate-script`) |

---

## Schéma MongoDB d'un cours (`Course`)

```typescript
{
  title: string,
  matiereId: string,           // référence PostgreSQL
  sourceFileUrl: string,       // chemin relatif /uploads/...
  sourceFileType: string,      // 'pdf' | 'pptx' | 'docx'
  resume: {
    text: string,              // dernier résumé validé
    llmProvider: string,       // fournisseur LLM utilisé
    generatedAt: Date,
  },
  podcast: {
    audioUrl: string,          // URL audio (vide jusqu'à étape TTS)
    transcript: string,        // JSON.stringify(Array<{speaker, text}>)
    generatedAt: Date,
  },
  resumeAttempts: [{           // historique complet des tentatives
    attemptNumber: number,
    generatedText: string,
    judgeScore: number,        // score /100
    judgeFeedback: string,
    evaluationData: object,    // résultat complet du juge LLM
    generationModel: string,
    judgeModel: string,
    createdAt: Date,
  }],
}
```

---

## Workflow génération podcast

```
POST /courses/:id/generate-podcast-script
  → Récupère course.resume.text depuis MongoDB
  → POST http://localhost:8000/podcast/generate-script
      { course_id, summary }
  → Reçoit { script: [{speaker, text}, ...], provider_used }
  → Sauvegarde course.podcast.transcript = JSON.stringify(script)
  → Retourne { status: 'done', script, provider_used }
```

---

## Structure du projet

```
src/
├── courses/
│   ├── courses.controller.ts     Endpoints /courses
│   ├── courses.service.ts        Logique métier + appels FastAPI
│   ├── courses.module.ts
│   ├── dto/
│   └── schemas/
│       └── course.schema.ts      Schéma Mongoose (Resume, Podcast, ResumeAttempt, Course)
├── documents/
│   ├── documents.controller.ts
│   ├── documents.service.ts
│   └── ...
├── matieres/
│   ├── matieres.controller.ts
│   ├── matieres.service.ts
│   ├── matiere.entity.ts         Entité TypeORM (PostgreSQL)
│   └── ...
├── filters/
│   └── http-exception.filter.ts  Filtre global d'erreurs
├── app.module.ts
└── main.ts                       Bootstrap (CORS, pipes, filtres)
uploads/                          Fichiers uploadés
```

---

## Prochaine étape envisagée

Génération audio TTS du script podcast :
- Appel à `POST /podcast/generate-audio` sur le microservice AI
- Mise à jour de `podcast.audioUrl` en MongoDB
- Servir le fichier MP3 depuis le backend

# EduCast Backend — NestJS API

This backend exposes the REST API used by the EduCast platform for document upload, AI processing status, and course-library management.

## Current stack

- NestJS 11 + TypeScript
- PostgreSQL + TypeORM for document metadata
- MongoDB + Mongoose for the course library
- Multer for file upload
- FastAPI integration for AI summarization and indexing

## Runtime dependencies

- Node.js 18+ (20+ recommended)
- PostgreSQL running locally or via Docker
- MongoDB running locally or via Docker
- FastAPI AI service available at http://localhost:8000

## Environment variables

The backend reads the following variables from .env:

```env
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/educast
MONGODB_URI=mongodb://127.0.0.1:27017/educast
FASTAPI_URL=http://localhost:8000
```

## Local setup

```bash
cd educast-backend
npm install
npm run start:dev
```

On first start, TypeORM synchronizes the PostgreSQL schema automatically for development.

## PostgreSQL and MongoDB

- PostgreSQL stores document metadata in the documents table.
- MongoDB stores the course library entries, including title, subject, resume, and podcast metadata.

## API endpoints

### POST /documents/upload

Upload a document and trigger processing by the FastAPI service.

Request:
- multipart/form-data
- field name: file
- optional body fields: saveToLibrary, matiere

Accepted file types:
- .pdf
- .pptx
- .docx

### GET /documents/:id/summary

Retrieve the processing status and the generated summary when available.

### GET /matieres

Returns the list of fixed subjects used by the course-library UI.

### GET /courses

Returns courses stored in MongoDB. An optional matiere query parameter filters by subject.

### GET /courses/:id

Returns the full course detail stored in MongoDB.

## Status values

The document status can be one of:

- uploaded
- processing
- done
- error
- invalid_content

## Project structure

```text
src/
├── app.module.ts
├── courses/
│   ├── courses.controller.ts
│   ├── courses.service.ts
│   └── schemas/course.schema.ts
├── documents/
│   ├── document.entity.ts
│   ├── documents.controller.ts
│   ├── documents.service.ts
│   └── dto/document-response.dto.ts
└── filters/http-exception.filter.ts
```

## Notes

The frontend currently calls the backend on localhost:3000 directly, so the backend must be running before using the UI.

# EduCast Frontend — React + Vite

This frontend provides the user interface for EduCast.

## What is implemented today

- Upload of PDF, PPTX, and DOCX files
- Optional saving to the course library
- Subject selection before saving a course
- Polling of the document summary status
- Display of the generated summary and provider used
- Library view with filtering by subject
- Course detail view showing the summary and audio preview

## Main components

- UploadDocument.tsx
  - drag-and-drop upload UI
  - calls POST /documents/upload
  - polls GET /documents/:id/summary

- CourseLibrary.tsx
  - fetches /matieres and /courses
  - filters courses by subject
  - displays course details and audio playback when available

- App.tsx
  - mounts the upload panel and the course library

## Prerequisites

- Node.js 18+ (20+ recommended)
- The NestJS backend must be running on http://localhost:3000

## Local setup

```bash
cd educast-frontend
npm install
npm run dev
```

The application is typically available at http://localhost:5173.

## Notes

The frontend currently uses hard-coded localhost URLs for the backend. It does not yet rely on a dedicated Vite environment file for API configuration.

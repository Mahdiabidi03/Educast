import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Document, DocumentStatus } from './document.entity';
import { DocumentResponseDto } from './dto/document-response.dto';

import { CoursesService } from '../courses/courses.service';
import { MatieresService } from '../matieres/matieres.service';

// Shared MIME-type map used by both code paths
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document)
    private readonly documentsRepository: Repository<Document>,
    private readonly coursesService: CoursesService,
    private readonly matieresService: MatieresService,
  ) {}

  // ── Library path (persistent) ─────────────────────────────────────────────

  /**
   * POST /documents/upload — library flow.
   * Persists a Document row in PostgreSQL, then processes asynchronously.
   * When saveToLibrary=true the resulting summary is also written to MongoDB.
   */
  async createFromUpload(
    fileOriginal: Express.Multer.File,
    saveToLibrary: boolean = false,
    matiere?: string,
  ): Promise<DocumentResponseDto | any> {
    if (!fileOriginal) {
      throw new BadRequestException('No file provided.');
    }

    const file = await this.convertToPdfIfNeeded(fileOriginal);

    const doc = this.documentsRepository.create({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      status: DocumentStatus.PROCESSING,
      summary: null,
      provider: null,
      errorMessage: null,
    });

    const saved = await this.documentsRepository.save(doc);

    if (saveToLibrary) {
      const ext = require('path').extname(fileOriginal.originalname).toLowerCase();
      let originalName = fileOriginal.originalname;
      try {
        originalName = Buffer.from(fileOriginal.originalname, 'latin1').toString('utf8');
      } catch {}

      // Title deduced from filename without extension
      let title = originalName;
      if (title.toLowerCase().endsWith(ext)) {
        title = title.substring(0, title.length - ext.length);
      }
      title = title.replace(/[_-]/g, ' ');

      const allMatieres = await this.matieresService.findAll();
      let selectedMatiere = allMatieres.find(
        (m) => m.id === matiere || m.name === matiere,
      );
      if (!selectedMatiere && allMatieres.length > 0) {
        selectedMatiere = allMatieres[0];
      }

      if (!selectedMatiere) {
        throw new Error('No subjects available in PostgreSQL database.');
      }

      const course = await this.coursesService.create({
        title: title,
        matiereId: selectedMatiere.id,
        sourceFileUrl: `/uploads/${file.filename}`,
        sourceFileType: String(ext).replace('.', ''),
      });
      return { document: this.toDto(saved), courseId: course._id };
    }

    return this.toDto(saved);
  }

  /**
   * Persistent "Résumé rapide" path per user.
   * Processes the file via FastAPI /ingest, saves the document & summary to MongoDB
   * associated with ownerId (the logged-in student), and returns the course object.
   */
  async quickSummaryPersistent(
    fileOriginal: Express.Multer.File,
    ownerId: string,
  ): Promise<{
    status: string;
    courseId?: string;
    summary: string | null;
    provider: string | null;
    errorMessage?: string;
    evaluation?: unknown;
    course?: any;
  }> {
    if (!fileOriginal) {
      throw new BadRequestException('No file provided.');
    }

    const file = await this.convertToPdfIfNeeded(fileOriginal);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FormData = require('form-data');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');

    const ext = path.extname(file.originalname).toLowerCase();
    const contentType =
      MIME_TYPES[ext] ?? file.mimetype ?? 'application/octet-stream';

    let originalName: string;
    try {
      originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch {
      originalName = file.originalname;
    }

    let title = originalName;
    if (title.toLowerCase().endsWith(ext)) {
      title = title.substring(0, title.length - ext.length);
    }
    title = title.replace(/[_-]/g, ' ');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    let fileHash: string | null = null;
    try {
      const fileBuf = fs.readFileSync(file.path);
      fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
    } catch (hErr) {
      console.warn('[NestJS] Could not compute file hash:', hErr);
    }

    const sourceFileUrl = `/uploads/${file.filename}`;
    const sourceFileType = ext.replace(/^\./, '') || 'pdf';

    // 1. Check if course with identical content/hash or title/filename already exists in DB
    try {
      const existingCourse = await this.coursesService.findExistingCourseByHashOrTitleOrFilename(fileHash, title, originalName);
      if (existingCourse && existingCourse.resume?.text) {
        console.log(`[NestJS] Found existing course matching content/title "${title}". Reusing existing summary, script, and audio...`);
        const summaryText = existingCourse.resume.text;
        const providerName = existingCourse.resume.llmProvider ?? 'groq';
        const attempts = existingCourse.resumeAttempts ?? [];
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
        const evaluation = latestAttempt?.evaluationData ?? null;
        const podcastData = {
          transcript: existingCourse.podcast?.transcript ?? '',
          audioUrl: existingCourse.podcast?.audioUrl ?? '',
        };

        const course = await this.coursesService.createQuickGenerateCourse({
          ownerId,
          title,
          sourceFileUrl: existingCourse.sourceFileUrl || sourceFileUrl,
          sourceFileType: existingCourse.sourceFileType || sourceFileType,
          summary: summaryText,
          provider: providerName,
          evaluation,
          podcast: podcastData,
          fileHash: fileHash || existingCourse.fileHash,
        });

        return {
          status: 'done',
          courseId: course._id.toString(),
          summary: summaryText,
          provider: providerName,
          evaluation,
          course,
        };
      }
    } catch (existErr: any) {
      console.warn(`[NestJS] Error checking existing course:`, existErr.message);
    }

    // 2. Immediately create pending course in MongoDB so GET /my-courses lists it while generating
    const pendingCourse = await this.coursesService.createQuickGenerateCourse({
      ownerId,
      title,
      sourceFileUrl,
      sourceFileType,
      summary: '',
      fileHash,
    });

    const ephemeralId = pendingCourse._id.toString();

    try {
      const formData = new FormData();
      formData.append('document_id', ephemeralId);
      formData.append('file', fs.createReadStream(file.path), {
        filename: originalName,
        contentType,
      });

      const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
      const response = await axios.post(`${fastApiUrl}/ingest`, formData, {
        headers: formData.getHeaders(),
        timeout: 0,
      });

      const data = response.data as Record<string, any>;

      if (data?.status === 'done') {
        const summaryText = (data.summary as string) ?? '';
        const providerName = (data.provider_used as string) ?? null;
        const evaluation = data.evaluation ?? null;

        pendingCourse.resume = {
          text: summaryText,
          generatedAt: new Date(),
          llmProvider: providerName,
        };
        pendingCourse.resumeAttempts = [
          {
            attemptNumber: 1,
            promptUsed: 'Prompt initial généré automatiquement',
            generatedText: summaryText,
            judgeScore: evaluation?.final_score ?? 0,
            judgeFeedback: evaluation?.feedback ?? '',
            evaluationData: evaluation ?? {},
            generationModel: providerName ?? 'groq',
            judgeModel: evaluation?.selected_model ?? 'mistral',
            createdAt: new Date(),
          },
        ];
        await pendingCourse.save();

        return {
          status: 'done',
          courseId: pendingCourse._id.toString(),
          summary: summaryText,
          provider: providerName,
          evaluation,
          course: pendingCourse,
        };
      }

      if (data?.status === 'invalid_content') {
        return {
          status: 'invalid_content',
          summary: null,
          provider: null,
          errorMessage:
            (data.message as string) ?? 'Contenu non exploitable.',
        };
      }

      return {
        status: 'error',
        summary: null,
        provider: null,
        errorMessage: 'Réponse inattendue du service de traitement.',
      };
    } catch (error: any) {
      let detail: string = error.message as string;
      if (error.response) {
        const body = error.response.data as unknown;
        detail = `HTTP ${String(error.response.status)} — ${typeof body === 'object' ? (body as any)?.detail : body}`;
      }
      console.error(`[NestJS] quickSummaryPersistent error: ${detail}`);
      return {
        status: 'error',
        summary: null,
        provider: null,
        errorMessage: detail,
      };
    }
  }

  // ── Ephemeral "Résumé rapide" path (nothing persisted) ───────────────────

  /**
   * POST /documents/quick-summary — ephemeral flow.
   *
   * Sends the file to FastAPI, waits for the summary, then:
   * - Deletes the uploaded file from disk
   * - Returns the summary inline in the HTTP response
   * - NEVER writes anything to PostgreSQL or MongoDB
   *
   * The caller (QuickGenerate) receives the result directly; no polling needed.
   */
  async quickSummary(
    fileOriginal: Express.Multer.File,
  ): Promise<{
    status: string;
    summary: string | null;
    provider: string | null;
    errorMessage?: string;
    evaluation?: unknown;
  }> {
    if (!fileOriginal) {
      throw new BadRequestException('No file provided.');
    }
    
    const file = await this.convertToPdfIfNeeded(fileOriginal);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FormData = require('form-data');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');

    const ext = path.extname(file.originalname).toLowerCase();
    const contentType =
      MIME_TYPES[ext] ?? file.mimetype ?? 'application/octet-stream';

    let originalName: string;
    try {
      originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch {
      originalName = file.originalname;
    }

    // Transient ID — never referenced in any database
    const ephemeralId = `quick-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      const formData = new FormData();
      formData.append('document_id', ephemeralId);
      formData.append('file', fs.createReadStream(file.path), {
        filename: originalName,
        contentType,
      });

      const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
      const response = await axios.post(`${fastApiUrl}/ingest`, formData, {
        headers: formData.getHeaders(),
        timeout: 0, // allow slow local LLMs
      });

      const data = response.data as Record<string, any>;

      if (data?.status === 'done') {
        return {
          status: 'done',
          summary: (data.summary as string) ?? null,
          provider: (data.provider_used as string) ?? null,
          evaluation: data.evaluation ?? null,
        };
      }

      if (data?.status === 'invalid_content') {
        return {
          status: 'invalid_content',
          summary: null,
          provider: null,
          errorMessage:
            (data.message as string) ?? 'Contenu non exploitable.',
        };
      }

      return {
        status: 'error',
        summary: null,
        provider: null,
        errorMessage: 'Réponse inattendue du service de traitement.',
      };
    } catch (error: any) {
      let detail: string = error.message as string;
      if (error.response) {
        const body = error.response.data as unknown;
        detail = `HTTP ${String(error.response.status)} — ${typeof body === 'object' ? (body as any)?.detail : body}`;
      }
      console.error(`[NestJS] quickSummary error: ${detail}`);
      return {
        status: 'error',
        summary: null,
        provider: null,
        errorMessage: detail,
      };
    } finally {
      // Always clean up — the ephemeral file must not remain on disk
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          console.log(`[NestJS] Ephemeral file deleted: ${file.path}`);
        }
      } catch (cleanupErr) {
        console.warn(
          `[NestJS] Could not delete ephemeral file: ${String(cleanupErr)}`,
        );
      }
    }
  }

  // ── Library path — background processor ──────────────────────────────────

  /**
   * Sends a persisted Document to FastAPI and updates its DB record with the result.
   * When saveToLibrary=true also creates the corresponding MongoDB Course.
   */
  private async processDocumentWithFastAPI(
    doc: Document,
    file: Express.Multer.File,
    saveToLibrary: boolean = false,
    matiere?: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FormData = require('form-data');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');

    const ext = path.extname(file.originalname).toLowerCase();
    const contentType =
      MIME_TYPES[ext] ?? file.mimetype ?? 'application/octet-stream';

    // Decode the original filename from latin-1 (Multer default) → UTF-8
    let originalName: string;
    try {
      originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch {
      originalName = file.originalname;
    }
    console.log(
      `[NestJS] Uploading to FastAPI — filename: "${originalName}" | contentType: ${contentType}`,
    );

    try {
      const formData = new FormData();
      formData.append('document_id', doc.id);
      formData.append('file', fs.createReadStream(file.path), {
        filename: originalName,
        contentType,
      });

      const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
      const response = await axios.post(`${fastApiUrl}/ingest`, formData, {
        headers: formData.getHeaders(),
        timeout: 0,
      });

      if (response.data && response.data.status === 'done') {
        doc.status = DocumentStatus.DONE;
        doc.summary = response.data.summary;
        doc.provider = response.data.provider_used;
        await this.documentsRepository.save(doc);

        if (saveToLibrary) {
          try {
            const summaryText = doc.summary ?? '';
            const providerName = doc.provider ?? 'unknown';

            // Resolve the subject UUID from the name/ID passed in
            const allMatieres = await this.matieresService.findAll();
            let selectedMatiere = allMatieres.find(
              (m) => m.id === matiere || m.name === matiere,
            );
            if (!selectedMatiere && allMatieres.length > 0) {
              selectedMatiere = allMatieres[0];
            }

            if (!selectedMatiere) {
              throw new Error('No subjects available in PostgreSQL database.');
            }

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const cryptoLib = require('crypto');
            let bHash: string | null = null;
            try {
              const bBuf = fs.readFileSync(file.path);
              bHash = cryptoLib.createHash('sha256').update(bBuf).digest('hex');
            } catch (e) {}

            await this.coursesService.create({
              title: originalName,
              matiereId: selectedMatiere.id,
              sourceFileUrl: `/uploads/${file.filename}`,
              sourceFileType: String(ext).replace('.', ''),
              fileHash: bHash,
              resume: {
                text: summaryText,
                generatedAt: new Date(),
                llmProvider: providerName,
              },
              podcast: {
                audioUrl: '',
                transcript: '',
              },
            });
            console.log(
              `[NestJS] Course saved to MongoDB library: ${originalName}`,
            );
          } catch (libErr) {
            console.error('[NestJS] Failed to save course to library:', libErr);
          }
        }
      } else if (
        response.data &&
        response.data.status === 'invalid_content'
      ) {
        doc.status = DocumentStatus.INVALID_CONTENT;
        doc.summary = null;
        doc.provider = null;
        doc.errorMessage =
          response.data.message ?? 'Contenu non exploitable.';
        console.warn(
          `[NestJS] Document ${doc.id} flagged as invalid_content: ${doc.errorMessage}`,
        );
        await this.documentsRepository.save(doc);
      } else {
        throw new Error('Unexpected response format from FastAPI');
      }
    } catch (error: any) {
      let detail = error.message;
      if (error.response) {
        const body = error.response.data;
        const fastApiDetail =
          typeof body === 'object' ? body?.detail : body;
        detail = `HTTP ${error.response.status} from FastAPI — ${fastApiDetail ?? error.message}`;
      }
      console.error(
        `[NestJS] Error processing document ${doc.id}: ${detail}`,
      );
      doc.status = DocumentStatus.ERROR;
      doc.errorMessage = detail;
      await this.documentsRepository.save(doc);
    }
  }

  // ── Polling endpoint (library path only) ─────────────────────────────────

  /**
   * GET /documents/:id/summary — returns status + summary for a persisted document.
   * Only used by the library flow after createFromUpload.
   */
  async getSummary(id: string): Promise<DocumentResponseDto> {
    const doc = await this.documentsRepository.findOne({ where: { id } });
    if (!doc) {
      throw new NotFoundException(`Document with id "${id}" not found.`);
    }
    return this.toDto(doc);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────
  
  private async convertToPdfIfNeeded(file: Express.Multer.File): Promise<Express.Multer.File> {
    const path = require('path');
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (ext === '.pdf') return file;

    const fs = require('fs').promises;
    const fsSync = require('fs');
    const libre = require('libreoffice-convert');
    const { promisify } = require('util');
    const convertAsync = promisify(libre.convert);

    // Hardcode path for Windows since it's installed there and not in PATH
    const librePath = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
    if (fsSync.existsSync(librePath)) {
      process.env.SOFFICE_PATH = librePath;
    } else {
      console.warn(`[NestJS] LibreOffice not found at ${librePath}. Assuming it's in PATH.`);
    }

    console.log(`[NestJS] Converting ${file.originalname} to PDF using LibreOffice...`);
    try {
      const fileBuffer = await fs.readFile(file.path);
      const pdfBuf = await convertAsync(fileBuffer, '.pdf', undefined);
      
      const newFilename = file.filename.replace(new RegExp(`${ext}$`, 'i'), '.pdf');
      const newPath = path.join(path.dirname(file.path), newFilename);
      await fs.writeFile(newPath, pdfBuf);
      
      try {
        await fs.unlink(file.path);
      } catch (e) {}
      
      console.log(`[NestJS] Conversion successful. New file: ${newPath}`);
      return {
        ...file,
        filename: newFilename,
        originalname: file.originalname.replace(new RegExp(`${ext}$`, 'i'), '.pdf'),
        mimetype: 'application/pdf',
        path: newPath,
      } as Express.Multer.File;
    } catch (err) {
      console.error(`[NestJS] Document conversion failed:`, err);
      // Fallback: return original file, though it will likely fail downstream if it only expects PDF.
      return file;
    }
  }

  private toDto(doc: Document): DocumentResponseDto {
    const dto = new DocumentResponseDto();
    dto.id = doc.id;
    dto.filename = doc.filename;
    dto.originalName = doc.originalName;
    dto.status = doc.status;
    dto.summary = doc.summary;
    dto.provider = doc.provider;
    dto.errorMessage = doc.errorMessage;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}

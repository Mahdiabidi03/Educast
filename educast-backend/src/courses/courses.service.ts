import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Model } from 'mongoose';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Course } from './schemas/course.schema';
import { ChatMessage } from './schemas/chat-message.schema';
import { Matiere } from '../matieres/matiere.entity';

@Injectable()
export class CoursesService implements OnModuleInit {
  constructor(
    @InjectModel(Course.name) private readonly courseModel: Model<Course>,
    @InjectModel(ChatMessage.name) private readonly chatMessageModel: Model<ChatMessage>,
    @InjectRepository(Matiere)
    private readonly matiereRepository: Repository<Matiere>,
  ) {}

  async onModuleInit() {
    // Seed default subjects if database is empty
    const count = await this.matiereRepository.count();
    if (count === 0) {
      console.log('[NestJS] Seeding default matieres in PostgreSQL...');
      const defaults = [
        'Analyse et Decisions Financieres',
        'Analyse Numerique',
        "Environnement Strategie d'entreprise",
        'Genie Logiciel',
        'Java',
        'Machine Learning',
        'Reseau',
        'Sys De Ges Base des Données',
        'Symfony',
        'Proba',
        'Theorie de language',
      ];
      for (const name of defaults) {
        await this.matiereRepository.save(
          this.matiereRepository.create({ name }),
        );
      }
      console.log('[NestJS] Seeding completed.');
    }

  }


  async findAll(matiereId?: string) {
    const filter: any = {
      $or: [{ source: 'library' }, { source: { $exists: false } }, { source: null }],
    };
    if (matiereId) {
      filter.matiereId = matiereId;
    }
    const courses = await this.courseModel
      .find(filter)
      .select('title matiereId createdAt _id sourceFileUrl sourceFileType resume podcast resumeAttempts source ownerId')
      .lean()
      .exec();

    // Null out sourceFileUrl for any course whose physical file no longer exists
    // on disk — prevents the frontend from making a request that would return 404.
    const uploadsRoot = join(process.cwd(), 'uploads');
    return courses.map((course) => {
      if (course.sourceFileUrl && course.sourceFileUrl.startsWith('/uploads/')) {
        const relativePath = course.sourceFileUrl.slice('/uploads/'.length);
        if (!existsSync(join(uploadsRoot, relativePath))) {
          return { ...course, sourceFileUrl: null };
        }
      }
      return course;
    });
  }

  async findOne(id: string) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }
    return course;
  }

  async create(createCourseDto: Partial<Course>) {
    // Validate that the matiereId exists in PostgreSQL
    const matiere = await this.matiereRepository.findOne({
      where: { id: createCourseDto.matiereId },
    });
    if (!createCourseDto.matiereId || !matiere) {
      throw new BadRequestException('La matière associée est obligatoire et doit être valide.');
    }

    const createdCourse = new this.courseModel(createCourseDto);
    const savedCourse = await createdCourse.save();
    console.log(`[NestJS] Course created in MongoDB: ${savedCourse._id}`);
    return savedCourse;
  }

  async update(id: string, updateCourseDto: Partial<Course>) {
    const existingCourse = await this.courseModel.findById(id).exec();
    if (!existingCourse) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    if (updateCourseDto.matiereId) {
      const matiere = await this.matiereRepository.findOne({
        where: { id: updateCourseDto.matiereId },
      });
      if (!matiere) {
        throw new BadRequestException('Matière invalide.');
      }
    }

    // Unlink old file if sourceFileUrl is updated — only when no other course
    // shares the same physical file (guard against cross-course file sharing).
    if (updateCourseDto.sourceFileUrl && updateCourseDto.sourceFileUrl !== existingCourse.sourceFileUrl) {
      const oldUrl = existingCourse.sourceFileUrl;
      const fileName = oldUrl.replace(/^\/uploads\//, '');
      const absolutePath = join(process.cwd(), 'uploads', fileName);
      if (existsSync(absolutePath)) {
        const shared = await this.isFileShared(oldUrl, id);
        if (shared) {
          console.log(`[NestJS] Skipping unlink of old file for course ${id} — still referenced by another course: ${absolutePath}`);
        } else {
          try {
            unlinkSync(absolutePath);
            console.log(`[NestJS] Removed old file for course ${id}: ${absolutePath}`);
          } catch (err) {
            console.error(`[NestJS] Failed to unlink old file ${absolutePath}:`, err);
          }
        }
      }
    }

    const updatedCourse = await this.courseModel.findByIdAndUpdate(
      id,
      { $set: updateCourseDto },
      { new: true, runValidators: true },
    );

    return updatedCourse;
  }

  async remove(id: string) {
    // Check file sharing BEFORE deleting the MongoDB document so we can still
    // query other references to the same path.
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    const sourceFileUrl = (course as any).sourceFileUrl as string | undefined;
    let sourceFileShared = false;
    if (sourceFileUrl) {
      sourceFileShared = await this.isFileShared(sourceFileUrl, id);
    }

    await this.courseModel.findByIdAndDelete(id);

    if (sourceFileUrl) {
      const fileName = sourceFileUrl.replace(/^\/uploads\//, '');
      const absolutePath = join(process.cwd(), 'uploads', fileName);
      if (existsSync(absolutePath)) {
        if (sourceFileShared) {
          console.log(`[NestJS] Skipping unlink for deleted course ${id} — file still referenced elsewhere: ${absolutePath}`);
        } else {
          try {
            unlinkSync(absolutePath);
            console.log(`[NestJS] Removed stored file for course ${id}: ${absolutePath}`);
          } catch (err) {
            console.error(`[NestJS] Failed to unlink file ${absolutePath}:`, err);
          }
        }
      }
    }

    return { deleted: true, id };
  }

  async removeMyQuickCourse(id: string, ownerId: string) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }
    const courseOwner = (course as any).ownerId?.toString();
    if (courseOwner !== ownerId.toString()) {
      throw new BadRequestException('You can only delete your own courses.');
    }

    // Check sharing BEFORE deleting the document so countDocuments sees the
    // full set of other references.
    const sourceFileUrl = (course as any).sourceFileUrl as string | undefined;
    const podcastAudioUrl = (course as any).podcast?.audioUrl as string | undefined;

    const sourceShared = sourceFileUrl ? await this.isFileShared(sourceFileUrl, id) : false;
    const podcastShared = podcastAudioUrl ? await this.isFileShared(podcastAudioUrl, id) : false;

    await this.courseModel.findByIdAndDelete(id);

    // Only delete the physical PDF if no other course references it.
    if (sourceFileUrl) {
      const fileName = sourceFileUrl.replace(/^\/uploads\//, '');
      const absolutePath = join(process.cwd(), 'uploads', fileName);
      if (existsSync(absolutePath)) {
        if (sourceShared) {
          console.log(`[NestJS] Skipping PDF unlink for quick-course ${id} — shared with Library or another student: ${absolutePath}`);
        } else {
          try {
            unlinkSync(absolutePath);
            console.log(`[NestJS] Removed PDF for quick-course ${id}: ${absolutePath}`);
          } catch (err) {
            console.error(`[NestJS] Failed to unlink PDF ${absolutePath}:`, err);
          }
        }
      }
    }

    // Only delete the podcast MP3 if no other course references it.
    if (podcastAudioUrl && podcastAudioUrl.startsWith('/uploads/')) {
      const mp3Name = podcastAudioUrl.replace(/^\/uploads\//, '');
      const mp3Path = join(process.cwd(), 'uploads', mp3Name);
      if (existsSync(mp3Path)) {
        if (podcastShared) {
          console.log(`[NestJS] Skipping podcast unlink for quick-course ${id} — shared with another course: ${mp3Path}`);
        } else {
          try {
            unlinkSync(mp3Path);
            console.log(`[NestJS] Removed podcast MP3 for quick-course ${id}: ${mp3Path}`);
          } catch (err) {
            console.error(`[NestJS] Failed to unlink podcast MP3 ${mp3Path}:`, err);
          }
        }
      }
    }

    return { deleted: true, id };
  }

  async generateSummary(id: string) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    if (!course.sourceFileUrl) {
      throw new BadRequestException('No source file attached to this course');
    }

    const fs = require('fs');
    const axios = require('axios').default;
    const FormData = require('form-data');
    const path = require('path');

    const fileName = course.sourceFileUrl.replace(/^\/uploads\//, '');
    const absolutePath = join(process.cwd(), 'uploads', fileName);

    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`File not found: ${absolutePath}`);
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const contentType = mimeTypes[ext] ?? 'application/octet-stream';

    try {
      const formData = new FormData();
      formData.append('document_id', course._id.toString());
      formData.append('file', fs.createReadStream(absolutePath), {
        filename: fileName,
        contentType,
      });

      const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
      const response = await axios.post(`${fastApiUrl}/ingest`, formData, {
        headers: formData.getHeaders(),
        timeout: 0,
      });

      if (response.data && response.data.status === 'done') {
        const summaryText: string = response.data.summary ?? '';
        const providerName: string = response.data.provider_used ?? 'unknown';
        const evaluation = response.data.evaluation ?? null;

        course.resume = {
          text: summaryText,
          llmProvider: providerName,
        } as any;

        // Record attempt #1 in history
        const attempt = {
          attemptNumber: 1,
          promptUsed: '',           // prompt is built inside the AI service; not returned
          generatedText: summaryText,
          judgeScore: evaluation?.final_score ?? 0,
          judgeFeedback: evaluation?.feedback ?? '',
          evaluationData: evaluation ?? {},
          generationModel: providerName,
          judgeModel: evaluation?.selected_model ?? null,
          createdAt: new Date(),
        };
        course.resumeAttempts = [...(course.resumeAttempts ?? []), attempt];

        await course.save();
        return {
          status: 'done',
          summary: summaryText,
          provider: providerName,
          evaluation,
        };
      } else if (response.data && response.data.status === 'invalid_content') {
        throw new BadRequestException(response.data.message ?? 'Contenu non exploitable.');
      } else {
        throw new Error('Unexpected response format from FastAPI');
      }
    } catch (error: any) {
      let detail = error.message;
      if (error.response) {
         detail = `HTTP ${error.response.status} from FastAPI — ${error.response.data?.detail ?? error.message}`;
      }
      console.error(`[NestJS] Error generating summary for course ${id}: ${detail}`);
      throw new BadRequestException(`Generation failed: ${detail}`);
    }
  }

  /**
   * Regenerate the summary using the AI service's /regenerate-summary endpoint.
   *
   * The AI service builds an improved prompt from the previous judge feedback,
   * runs the generation + evaluation, and logs everything to MLflow. This method
   * stores the new summary in MongoDB and appends the attempt to resumeAttempts.
   */
  async regenerateSummary(
    id: string,
    previousFeedback: string,
    attemptNumber: number,
    previousSummary: string = '',
  ) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    if (!course.sourceFileUrl) {
      throw new BadRequestException('No source file attached to this course');
    }

    const fs = require('fs');
    const axios = require('axios').default;
    const FormData = require('form-data');
    const path = require('path');
    const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';

    const fileName = course.sourceFileUrl.replace(/^\/uploads\//, '');
    const absolutePath = join(process.cwd(), 'uploads', fileName);

    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`File not found on disk: ${absolutePath}`);
    }

    try {
      // ── Step 1: Regenerate with improved prompt using judge feedback ───────
      console.log(`[NestJS] Sending regeneration request for course ${id} (attempt #${attemptNumber})...`);
      
      const formData = new FormData();
      formData.append('document_id', course._id.toString());
      formData.append('previous_feedback', previousFeedback);
      formData.append('previous_summary', previousSummary);
      formData.append('attempt_number', attemptNumber.toString());

      const ext = path.extname(absolutePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';

      formData.append('file', fs.createReadStream(absolutePath), {
        filename: fileName,
        contentType,
      });

      const response = await axios.post(
        `${fastApiUrl}/regenerate-summary`,
        formData,
        {
          headers: formData.getHeaders(),
          timeout: 0,
        },
      );

      const data = response.data;
      const summaryText: string = data.summary ?? '';
      const providerName: string = data.provider_used ?? 'unknown';
      const evaluation = data.evaluation ?? null;

      // Update the latest summary in the course document
      course.resume = {
        text: summaryText,
        llmProvider: providerName,
      } as any;

      // Append this attempt to the history
      const attempt = {
        attemptNumber,
        promptUsed: data.improved_prompt_used ?? '',
        generatedText: summaryText,
        judgeScore: evaluation?.final_score ?? 0,
        judgeFeedback: evaluation?.feedback ?? '',
        evaluationData: evaluation ?? {},
        generationModel: providerName,
        judgeModel: evaluation?.selected_model ?? null,
        createdAt: new Date(),
      };
      course.resumeAttempts = [...(course.resumeAttempts ?? []), attempt];

      await course.save();

      return {
        status: 'done',
        summary: summaryText,
        provider: providerName,
        evaluation,
        attemptNumber,
      };
    } catch (error: any) {
      let detail = error.message;
      if (error.response) {
        const rawDetail = error.response.data?.detail;
        let formattedDetail = error.message;
        if (typeof rawDetail === 'string') {
          formattedDetail = rawDetail;
        } else if (Array.isArray(rawDetail)) {
          formattedDetail = rawDetail
            .map((d: any) => d.msg || JSON.stringify(d))
            .join('; ');
        } else if (rawDetail && typeof rawDetail === 'object') {
          formattedDetail = rawDetail.message || JSON.stringify(rawDetail);
        }
        detail = `HTTP ${error.response.status} from FastAPI — ${formattedDetail}`;
      }
      console.error(
        `[NestJS] Error regenerating summary for course ${id} (attempt ${attemptNumber}): ${detail}`,
      );
      throw new BadRequestException(`Regeneration failed: ${detail}`);
    }
  }

  /**
   * Generate a professor/student dialogue podcast script from the course's
   * validated summary.  The AI service's /podcast/generate-script endpoint is
   * called with the current summary text, and the returned script is persisted
   * as a JSON string in course.podcast.transcript.
   */
  async generatePodcastScript(id: string, correctionPrompt?: string) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    // Check if an existing podcast transcript exists
    let previousScript: Array<{ speaker: string; text: string }> | null = null;
    if (course.podcast?.transcript) {
      try {
        const parsed = JSON.parse(course.podcast.transcript);
        if (Array.isArray(parsed) && parsed.length > 0) {
          previousScript = parsed;
        }
      } catch {}
    }

    // Always use the LATEST resume attempt text as the source
    const attempts = course.resumeAttempts ?? [];
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
    let summaryText = latestAttempt?.generatedText || course.resume?.text || '';

    if (!previousScript && !summaryText) {
      throw new BadRequestException(
        'Ce cours ne possède pas encore de résumé validé. ' +
          'Générez le résumé avant de lancer la génération du podcast.',
      );
    }

    const axios = require('axios').default;
    const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';

    try {
      console.log(
        `[NestJS] Generating/refining podcast script for course ${id} (hasPrevious: ${!!previousScript}, hasCorrection: ${!!correctionPrompt})…`,
      );

      const response = await axios.post(
        `${fastApiUrl}/podcast/generate-script`,
        {
          course_id: id,
          summary: summaryText,        // always send latest summary
          previous_script: previousScript,
          correction_prompt: correctionPrompt ?? null,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 0 },
      );

      const data = response.data;
      const script: Array<{ speaker: string; text: string }> = data.script ?? [];
      const providerUsed: string = data.provider_used ?? 'unknown';

      // Persist transcript and reset audioUrl since new script is generated
      course.podcast = {
        ...(course.podcast ?? {}),
        transcript: JSON.stringify(script),
        audioUrl: '',
        generatedAt: new Date(),
      } as any;

      await course.save();

      console.log(
        `[NestJS] Podcast script saved for course ${id} — ` +
          `${script.length} turns, provider: ${providerUsed}`,
      );

      return {
        status: 'done',
        script,
        provider_used: providerUsed,
        token_usage: data.token_usage ?? {},
      };
    } catch (error: any) {
      console.error(
        `[NestJS] Error generating podcast script for course ${id}:`,
        error.message,
      );
      throw new BadRequestException('Podcast script generation failed');
    }
  }

  async findExistingCourseByHashOrTitleOrFilename(fileHash: string | null, title: string, filename: string) {
    const cleanTitle = title.trim();
    const cleanFilename = filename.trim();

    // 1. Direct query by fileHash or title/filename
    const queryOr: any[] = [];
    if (fileHash) {
      queryOr.push({ fileHash });
    }
    if (cleanTitle) {
      const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      queryOr.push({ title: new RegExp(escapedTitle, 'i') });
    }
    if (cleanFilename) {
      const escapedFilename = cleanFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      queryOr.push({ sourceFileUrl: new RegExp(escapedFilename, 'i') });
    }

    if (queryOr.length > 0) {
      const directMatch = await this.courseModel
        .findOne({
          $or: queryOr,
          'resume.text': { $exists: true, $ne: '' },
        })
        .exec();

      if (directMatch) {
        console.log(`[NestJS] Direct DB match found for course "${directMatch.title}" (${directMatch._id})`);
        return directMatch;
      }
    }

    // 2. Fallback on-the-fly disk file hash check for courses in DB without fileHash
    if (fileHash) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto');

      const allCoursesWithResume = await this.courseModel
        .find({ 'resume.text': { $exists: true, $ne: '' } })
        .exec();

      for (const course of allCoursesWithResume) {
        if (course.sourceFileUrl) {
          const rawName = course.sourceFileUrl.replace(/^\/uploads\//, '');
          const possiblePaths = [
            path.join(process.cwd(), 'uploads', rawName),
            path.join(process.cwd(), 'public', 'uploads', rawName),
            path.join(process.cwd(), '..', 'uploads', rawName),
          ];

          for (const diskPath of possiblePaths) {
            if (fs.existsSync(diskPath)) {
              try {
                const buf = fs.readFileSync(diskPath);
                const computedHash = crypto.createHash('sha256').update(buf).digest('hex');
                // Backfill fileHash on course for future fast queries
                if (!course.fileHash) {
                  course.fileHash = computedHash;
                  await course.save();
                }
                if (computedHash === fileHash) {
                  console.log(`[NestJS] Disk file SHA-256 matched existing course "${course.title}" (${course._id})`);
                  return course;
                }
              } catch (hErr) {
                // ignore unreadable file
              }
              break;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Find all Quick Generate courses owned by a specific student.
   */
  async findByOwner(ownerId: string) {
    return this.courseModel
      .find({ source: 'quick_generate', ownerId })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Creates a persistent Quick Generate course document tied to a student.
   */
  async createQuickGenerateCourse(params: {
    ownerId: string;
    title: string;
    sourceFileUrl: string;
    sourceFileType: string;
    summary: string;
    provider?: string | null;
    evaluation?: any;
    podcast?: { transcript?: string; audioUrl?: string };
    fileHash?: string | null;
  }) {
    const { ownerId, title, sourceFileUrl, sourceFileType, summary, provider, evaluation, podcast, fileHash } = params;

    const initialAttempt = summary ? {
      attemptNumber: 1,
      promptUsed: 'Prompt initial généré automatiquement',
      generatedText: summary,
      judgeScore: evaluation?.final_score ?? 0,
      judgeFeedback: evaluation?.feedback ?? '',
      evaluationData: evaluation ?? {},
      generationModel: provider ?? 'groq',
      judgeModel: evaluation?.selected_model ?? 'mistral',
      createdAt: new Date(),
    } : null;

    const course = new this.courseModel({
      title,
      matiereId: 'quick-generate',
      sourceFileUrl,
      sourceFileType,
      source: 'quick_generate',
      ownerId,
      fileHash: fileHash ?? null,
      resume: {
        text: summary ?? '',
        generatedAt: new Date(),
        llmProvider: provider ?? 'groq',
      },
      podcast: {
        audioUrl: podcast?.audioUrl ?? '',
        transcript: podcast?.transcript ?? '',
        generatedAt: new Date(),
      },
      resumeAttempts: initialAttempt ? [initialAttempt] : [],
      createdAt: new Date(),
    });

    return course.save();
  }

  /**
   * Returns true if the given file URL (sourceFileUrl or podcast.audioUrl)
   * is referenced by at least one OTHER MongoDB document besides the one
   * being deleted/updated. Used to prevent deleting shared physical assets.
   */
  private async isFileShared(fileUrl: string, excludeId: string): Promise<boolean> {
    const count = await this.courseModel.countDocuments({
      _id: { $ne: excludeId },
      $or: [
        { sourceFileUrl: fileUrl },
        { 'podcast.audioUrl': fileUrl },
      ],
    });
    return count > 0;
  }

  async generatePodcastAudio(id: string) {
    const course = await this.courseModel.findById(id).exec();
    if (!course) {
      throw new NotFoundException(`Course with id ${id} not found`);
    }

    let script = [];
    if (course.podcast?.transcript) {
      try {
        script = JSON.parse(course.podcast.transcript);
      } catch (e) {}
    }

    if (!script || script.length === 0) {
      throw new BadRequestException('No podcast script found to generate audio from.');
    }

    const axios = require('axios').default;
    const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';

    try {
      console.log(`[NestJS] Requesting podcast audio generation for course ${id} (edge-tts)...`);
      const response = await axios.post(`${fastApiUrl}/podcast/generate-audio`, {
        course_id: id,
        script
      }, { timeout: 0 }); // No timeout, generation can be slow

      const audioUrl = response.data.audio_url;

      course.podcast = {
        ...(course.podcast ?? {}),
        audioUrl,
      } as any;
      await course.save();

      console.log(`[NestJS] Podcast audio saved for course ${id} at ${audioUrl}`);
      return { status: 'done', audioUrl };
    } catch (error: any) {
      console.error(`[NestJS] Error generating podcast audio for course ${id}:`, error.message);
      throw new BadRequestException('Podcast audio generation failed');
    }
  }

  async podcastAsk(
    id: string,
    question: string,
    transcriptSoFar: string,
    pausePositionS: number = 0,
    userId?: string,
  ) {
    const axios = require('axios').default;
    const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
    try {
      const response = await axios.post(`${fastApiUrl}/podcast/${id}/ask`, {
        question,
        transcript_so_far: transcriptSoFar,
        pause_position_s: pausePositionS,
      });

      const resData = response.data; // { answer, provider_used, token_usage, audio_url }

      if (userId && userId.trim() !== '') {
        try {
          // Save student question
          await this.chatMessageModel.create({
            courseId: id,
            userId,
            speaker: 'etudiant',
            text: question,
            isRag: true,
          });
          // Save professor answer
          if (resData.answer) {
            await this.chatMessageModel.create({
              courseId: id,
              userId,
              speaker: 'professeur',
              text: resData.answer,
              isRag: true,
              audioUrl: resData.audio_url || null,
            });
          }
        } catch (dbErr: any) {
          console.warn(`[NestJS] Failed to persist chat history for course ${id}, user ${userId}:`, dbErr.message);
        }
      }

      return resData;
    } catch (error: any) {
      console.error(`[NestJS] Error asking RAG question for course ${id}:`, error.message);
      throw new BadRequestException('Podcast ask failed');
    }
  }

  async getChatHistory(courseId: string, userId: string) {
    if (!userId) return [];
    return this.chatMessageModel
      .find({ courseId, userId })
      .sort({ createdAt: 1 })
      .exec();
  }

  async clearChatHistory(courseId: string, userId: string) {
    if (!userId) return { deletedCount: 0 };
    return this.chatMessageModel.deleteMany({ courseId, userId }).exec();
  }

  async batchGenerateAudio() {
    const courses = await this.courseModel.find({
      'podcast.transcript': { $exists: true, $ne: '' },
      $or: [{ 'podcast.audioUrl': { $exists: false } }, { 'podcast.audioUrl': '' }]
    }).exec();
    
    console.log(`[NestJS] Found ${courses.length} courses to batch generate audio for.`);
    
    const axios = require('axios').default;
    const fastApiUrl = process.env.FASTAPI_URL || 'http://localhost:8000';
    let successCount = 0;
    
    for (const course of courses) {
      try {
        let script = [];
        if (course.podcast?.transcript) {
          try {
            script = JSON.parse(course.podcast.transcript);
          } catch(e) {}
        }
        
        if (script.length > 0) {
          console.log(`[NestJS] Generating audio for course ${course._id}...`);
          const response = await axios.post(`${fastApiUrl}/podcast/generate-audio`, {
            course_id: course._id.toString(),
            script
          }, { timeout: 0 });
          
          course.podcast = {
            ...(course.podcast ?? {}),
            audioUrl: response.data.audio_url
          } as any;
          await course.save();
          successCount++;
        }
      } catch (error: any) {
        console.error(`[NestJS] Failed audio generation for course ${course._id}:`, error.message);
      }
    }
    
    return { status: 'done', totalProcessed: courses.length, successCount };
  }

}


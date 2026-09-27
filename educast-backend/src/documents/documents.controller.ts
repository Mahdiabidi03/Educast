import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { DocumentsService } from './documents.service';
import { DocumentResponseDto } from './dto/document-response.dto';
import { BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

// ── Multer configuration ─────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = ['.pdf', '.pptx', '.docx'];
const MAX_FILE_SIZE_MB = 50;

const multerOptions = {
  storage: diskStorage({
    destination: join(process.cwd(), 'uploads'),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniqueSuffix}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
  },
  fileFilter: (
    _req: any,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(
        new BadRequestException(
          `Invalid file type "${ext}". Only PDF, PPTX, and DOCX files are accepted.`,
        ),
        false,
      );
    }
    cb(null, true);
  },
};

// ── Controller ───────────────────────────────────────────────────────────────

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * POST /documents/upload
   *
   * Library flow — reserved for admins.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('saveToLibrary') saveToLibrary?: string,
    @Body('matiere') matiere?: string,
  ): Promise<DocumentResponseDto> {
    if (!file) {
      throw new BadRequestException(
        'A file must be attached with the field name "file".',
      );
    }
    const shouldSave = saveToLibrary === 'true' || saveToLibrary === '1';
    return this.documentsService.createFromUpload(file, shouldSave, matiere);
  }

  /**
   * POST /documents/quick-summary-persistent
   *
   * Persistent per-user "Résumé rapide" flow for logged-in students.
   */
  @UseGuards(JwtAuthGuard)
  @Post('quick-summary-persistent')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async quickSummaryPersistent(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) {
      throw new BadRequestException(
        'A file must be attached with the field name "file".',
      );
    }
    return this.documentsService.quickSummaryPersistent(file, req.user.id);
  }

  /**
   * POST /documents/quick-summary
   *
   * Ephemeral "Résumé rapide" flow — fallback.
   */
  @Post('quick-summary')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', multerOptions))
  async quickSummary(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ status: string; summary: string | null; provider: string | null; evaluation?: any; errorMessage?: string }> {
    if (!file) {
      throw new BadRequestException(
        'A file must be attached with the field name "file".',
      );
    }
    return this.documentsService.quickSummary(file);
  }

  /**
   * GET /documents/:id/summary
   */
  @Get(':id/summary')
  async getSummary(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DocumentResponseDto> {
    return this.documentsService.getSummary(id);
  }
}

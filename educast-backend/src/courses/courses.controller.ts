import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller()
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get('courses')
  findAll(@Query('matiere') matiereId?: string) {
    return this.coursesService.findAll(matiereId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('quick-generate/my-courses')
  findMyQuickGenerateCourses(@Request() req: any) {
    return this.coursesService.findByOwner(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('quick-generate/my-courses/:id')
  removeMyQuickCourse(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.removeMyQuickCourse(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('courses')
  create(@Body() createCourseDto: CreateCourseDto) {
    return this.coursesService.create(createCourseDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('courses/:id')
  update(@Param('id') id: string, @Body() updateCourseDto: Partial<CreateCourseDto>) {
    return this.coursesService.update(id, updateCourseDto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Delete('courses/:id')
  remove(@Param('id') id: string) {
    return this.coursesService.remove(id);
  }

  @Get('courses/:id')
  findOne(@Param('id') id: string) {
    return this.coursesService.findOne(id);
  }

  @Post('courses/:id/generate-summary')
  generateSummary(@Param('id') id: string) {
    return this.coursesService.generateSummary(id);
  }

  @Post('courses/:id/regenerate-summary')
  regenerateSummary(
    @Param('id') id: string,
    @Body() body: { previousFeedback: string; attemptNumber: number; previousSummary?: string },
  ) {
    return this.coursesService.regenerateSummary(
      id,
      body.previousFeedback ?? '',
      body.attemptNumber ?? 2,
      body.previousSummary ?? '',
    );
  }

  @Post('courses/:id/generate-podcast-script')
  generatePodcastScript(
    @Param('id') id: string,
    @Body() body?: { correctionPrompt?: string },
  ) {
    return this.coursesService.generatePodcastScript(id, body?.correctionPrompt);
  }

  @Post('courses/:id/generate-podcast-audio')
  generatePodcastAudio(@Param('id') id: string) {
    return this.coursesService.generatePodcastAudio(id);
  }

  @Post('courses/:id/podcast-ask')
  podcastAsk(
    @Param('id') id: string,
    @Body() body: { question: string; transcriptSoFar: string; pausePositionS?: number; userId?: string },
    @Request() req: any,
  ) {
    const userId = req.user?.id || body.userId;
    return this.coursesService.podcastAsk(
      id,
      body.question,
      body.transcriptSoFar,
      body.pausePositionS ?? 0,
      userId,
    );
  }

  @Get('courses/:id/chat')
  getChatHistory(
    @Param('id') id: string,
    @Query('userId') queryUserId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.id || queryUserId;
    return this.coursesService.getChatHistory(id, userId ?? '');
  }

  @Delete('courses/:id/chat')
  clearChatHistory(
    @Param('id') id: string,
    @Query('userId') queryUserId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.id || queryUserId;
    return this.coursesService.clearChatHistory(id, userId ?? '');
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('courses/batch-generate-audio')
  batchGenerateAudio() {
    return this.coursesService.batchGenerateAudio();
  }
}


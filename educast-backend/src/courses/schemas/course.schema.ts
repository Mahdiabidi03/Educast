import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ _id: false })
export class Resume {
  @Prop({ type: String, default: '' })
  text: string;

  @Prop({ type: Date, default: Date.now })
  generatedAt?: Date;

  // Explicit String type required — "string | null" union confuses @nestjs/mongoose
  @Prop({ type: String, default: null })
  llmProvider?: string | null;
}

@Schema({ _id: false })
export class Podcast {
  @Prop({ type: String, default: '' })
  audioUrl?: string;

  @Prop({ type: String, default: '' })
  transcript?: string;

  @Prop({ type: Date, default: Date.now })
  generatedAt?: Date;
}

/**
 * Stores the full history of every summary generation attempt for a course.
 * Each entry captures the prompt, generated text, judge evaluation, and
 * which models were used — so every version is traceable in both the app
 * and the MLflow dashboard.
 */
@Schema({ _id: false })
export class ResumeAttempt {
  /** Sequential attempt counter (1 = initial, 2+ = re-generations). */
  @Prop({ type: Number, required: true })
  attemptNumber: number;

  /** The full prompt string sent to the generation LLM. */
  @Prop({ type: String, required: true })
  promptUsed: string;

  /** The summary text produced in this attempt. */
  @Prop({ type: String, required: true })
  generatedText: string;

  /** Overall LLM-as-a-Judge score (0–100). */
  @Prop({ type: Number, required: true })
  judgeScore: number;

  /** Textual feedback returned by the judge LLM. */
  @Prop({ type: String, default: '' })
  judgeFeedback?: string;

  /** Full evaluation object returned by the judge (stored as-is). */
  @Prop({ type: Object, default: {} })
  evaluationData?: Record<string, any>;

  /** LLM provider that generated the summary (e.g. "Groq API"). */
  @Prop({ type: String, default: null })
  generationModel?: string | null;

  /** LLM provider that acted as the judge (e.g. "Mistral API"). */
  @Prop({ type: String, default: null })
  judgeModel?: string | null;

  @Prop({ type: Date, default: Date.now })
  createdAt?: Date;
}

@Schema({ timestamps: false })
export class Course extends Document {
  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true, index: true })
  matiereId: string;

  @Prop({ type: String, required: true })
  sourceFileUrl: string;

  @Prop({ type: String, required: true })
  sourceFileType: string;

  @Prop({ type: Resume, required: false })
  resume?: Resume;

  @Prop({ type: Podcast, required: false })
  podcast?: Podcast;

  /** Full history of every summary generation + evaluation attempt. */
  @Prop({ type: [Object], default: [] })
  resumeAttempts: ResumeAttempt[];

  @Prop({ type: [Object], default: [] })
  personalizedVersions: any[];

  @Prop({ type: String, default: 'library', index: true })
  source?: string;

  @Prop({ type: String, index: true, default: null })
  ownerId?: string | null;

  @Prop({ type: String, index: true, default: null })
  fileHash?: string | null;

  @Prop({ type: Date, default: Date.now })
  createdAt: Date;

  @Prop({ type: String })
  uploadedBy?: string;
}

export const CourseSchema = SchemaFactory.createForClass(Course);

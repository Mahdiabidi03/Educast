import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ChatMessage extends Document {
  @Prop({ type: String, required: true, index: true })
  courseId: string;

  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, enum: ['etudiant', 'professeur'] })
  speaker: string;

  @Prop({ type: String, required: true })
  text: string;

  @Prop({ type: Boolean, default: true })
  isRag: boolean;

  @Prop({ type: String, default: null })
  audioUrl?: string | null;

  @Prop({ type: Date, default: Date.now })
  createdAt: Date;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

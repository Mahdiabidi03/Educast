import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CreateResumeDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsOptional()
  @IsString()
  llmProvider?: string | null;
}

export class CreatePodcastDto {
  @IsOptional()
  @IsString()
  audioUrl?: string;

  @IsOptional()
  @IsString()
  transcript?: string;
}

export class CreateCourseDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  matiereId: string;

  @IsString()
  @IsNotEmpty()
  sourceFileUrl: string;

  @IsString()
  @IsNotEmpty()
  sourceFileType: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateResumeDto)
  resume?: CreateResumeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePodcastDto)
  podcast?: CreatePodcastDto;

  @IsOptional()
  @IsArray()
  personalizedVersions?: any[];

  @IsOptional()
  @IsString()
  uploadedBy?: string;
}

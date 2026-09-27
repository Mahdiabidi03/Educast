import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { DocumentStatus } from '../document.entity';

export class DocumentResponseDto {
  @IsUUID()
  id: string;

  @IsString()
  filename: string;

  @IsString()
  originalName: string;

  @IsEnum(DocumentStatus)
  status: DocumentStatus;

  @IsOptional()
  @IsString()
  summary: string | null;

  @IsOptional()
  @IsString()
  provider: string | null;

  @IsOptional()
  evaluation?: any;

  @IsOptional()
  @IsString()
  errorMessage: string | null;

  createdAt: Date;
}

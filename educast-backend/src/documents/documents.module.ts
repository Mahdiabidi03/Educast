import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from './document.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { CoursesModule } from '../courses/courses.module';
import { MatieresModule } from '../matieres/matieres.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document]),
    CoursesModule,
    MatieresModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}

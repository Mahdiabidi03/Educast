import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { MatieresController } from './matieres.controller';
import { MatieresService } from './matieres.service';
import { Matiere } from './matiere.entity';
import { Course, CourseSchema } from '../courses/schemas/course.schema';
import { CoursesModule } from '../courses/courses.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Matiere]),
    MongooseModule.forFeature([{ name: Course.name, schema: CourseSchema }]),
    forwardRef(() => CoursesModule),
  ],
  controllers: [MatieresController],
  providers: [MatieresService],
  exports: [MatieresService],
})
export class MatieresModule {}

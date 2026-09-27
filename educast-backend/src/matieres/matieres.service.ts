import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Matiere } from './matiere.entity';
import { Course } from '../courses/schemas/course.schema';
import { CoursesService } from '../courses/courses.service';

@Injectable()
export class MatieresService {
  constructor(
    @InjectRepository(Matiere)
    private readonly matiereRepository: Repository<Matiere>,
    @InjectModel(Course.name)
    private readonly courseModel: Model<Course>,
    @Inject(forwardRef(() => CoursesService))
    private readonly coursesService: CoursesService,
  ) {}

  async findAll() {
    return this.matiereRepository.find({ order: { name: 'ASC' } });
  }

  async create(name?: string) {
    const value = name?.trim();
    if (!value) {
      throw new BadRequestException('Le nom de la matière est obligatoire.');
    }
    const existing = await this.matiereRepository.findOne({ where: { name: value } });
    if (existing) {
      throw new BadRequestException(`La matière "${value}" existe déjà.`);
    }
    const newMatiere = this.matiereRepository.create({ name: value });
    await this.matiereRepository.save(newMatiere);
    return this.findAll();
  }

  async update(id: string, newName?: string) {
    const value = newName?.trim();
    if (!value) {
      throw new BadRequestException('Le nouveau nom de la matière est obligatoire.');
    }
    const matiere = await this.matiereRepository.findOne({ where: { id } });
    if (!matiere) {
      throw new NotFoundException(`Matière introuvable.`);
    }
    const existing = await this.matiereRepository.findOne({ where: { name: value } });
    if (existing && existing.id !== id) {
      throw new BadRequestException(`La matière "${value}" existe déjà.`);
    }
    matiere.name = value;
    await this.matiereRepository.save(matiere);
    return this.findAll();
  }

  async remove(id: string) {
    const matiere = await this.matiereRepository.findOne({ where: { id } });
    if (!matiere) {
      throw new NotFoundException(`Matière introuvable.`);
    }

    // Cascade delete: find all MongoDB courses with this matiereId and remove them via coursesService to clean up uploads
    const associatedCourses = await this.courseModel.find({ matiereId: id }).exec();
    for (const course of associatedCourses) {
      await this.coursesService.remove(course._id.toString());
    }

    await this.matiereRepository.remove(matiere);
    return this.findAll();
  }
}

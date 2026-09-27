import { CoursesService } from './courses.service';

describe('CoursesService', () => {
  it('creates a course and returns the saved document', async () => {
    const createdCourse = { _id: 'course-1', title: 'Intro', matiereId: 'matiere-1' };
    const save = jest.fn().mockResolvedValue(createdCourse);
    const courseModel = jest.fn().mockImplementation(() => ({ save })) as any;
    const chatMessageModel = {} as any;
    
    const matiereRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'matiere-1', name: 'Java' }),
    } as any;

    const service = new CoursesService(courseModel, chatMessageModel, matiereRepository);
    const result = await service.create({
      title: 'Intro',
      matiereId: 'matiere-1',
      sourceFileUrl: '/uploads/file.pdf',
      sourceFileType: 'pdf',
      resume: { text: 'Résumé', generatedAt: new Date(), llmProvider: 'gpt' },
      podcast: { audioUrl: '/podcasts/test.mp3', transcript: 'transcript', generatedAt: new Date() },
    } as any);

    expect(courseModel).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
    expect(result).toEqual(createdCourse);
  });

  it('updates a course title when requested', async () => {
    const updatedCourse = { _id: 'course-1', title: 'Nouveau titre', matiereId: 'matiere-1' };
    const findByIdAndUpdate = jest.fn().mockResolvedValue(updatedCourse);
    const courseModel = {
      findByIdAndUpdate,
    } as any;

    const matiereRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'matiere-1', name: 'Java' }),
    } as any;

    const chatMessageModel2 = {} as any;

    const service = new CoursesService(courseModel, chatMessageModel2, matiereRepository);
    const result = await service.update('course-1', { title: 'Nouveau titre' });

    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      'course-1',
      { $set: { title: 'Nouveau titre' } },
      { new: true, runValidators: true },
    );
    expect(result).toEqual(updatedCourse);
  });
});


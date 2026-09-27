import React, { useEffect, useState } from 'react';

interface CoursePreview {
  _id: string;
  title: string;
  matiere: string;
  createdAt: string;
}

interface CourseDetail extends CoursePreview {
  resume: {
    text: string;
  };
  podcast: {
    audioUrl: string;
  };
}

export const CourseLibrary: React.FC = () => {
  const [courses, setCourses] = useState<CoursePreview[]>([]);
  const [matieres, setMatieres] = useState<string[]>([]);
  const [matiereFilter, setMatiereFilter] = useState<string>('');
  const [selectedCourse, setSelectedCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  useEffect(() => {
    fetchMatieres();
  }, []);

  useEffect(() => {
    fetchCourses();
  }, [matiereFilter]);

  const fetchMatieres = async () => {
    try {
      const response = await fetch('http://localhost:3000/matieres');
      const data = await response.json();
      setMatieres(data);
    } catch (error) {
      console.error('Failed to fetch matieres', error);
    }
  };

  const fetchCourses = async () => {
    setLoading(true);
    try {
      const url = new URL('http://localhost:3000/courses');
      if (matiereFilter) {
        url.searchParams.append('matiere', matiereFilter);
      }
      const response = await fetch(url.toString());
      const data = await response.json();
      setCourses(data);
    } catch (error) {
      console.error('Failed to fetch courses', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCourseClick = async (id: string) => {
    setDetailLoading(true);
    try {
      const response = await fetch(`http://localhost:3000/courses/${id}`);
      const data = await response.json();
      setSelectedCourse(data);
    } catch (error) {
      console.error('Failed to fetch course details', error);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
      <h2>Bibliothèque de cours</h2>
      
      <div style={{ marginBottom: '1rem' }}>
        <label htmlFor="matiere-filter">Filtrer par matière: </label>
        <select 
          id="matiere-filter" 
          value={matiereFilter} 
          onChange={(e) => setMatiereFilter(e.target.value)}
        >
          <option value="">Toutes</option>
          {matieres.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>Chargement des cours...</p>
      ) : (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {courses.map(course => (
            <div 
              key={course._id} 
              onClick={() => handleCourseClick(course._id)}
              style={{ 
                padding: '1rem', 
                border: '1px solid var(--color-border)', 
                borderRadius: '4px', 
                cursor: 'pointer',
                backgroundColor: selectedCourse?._id === course._id ? 'rgba(var(--color-accent-rgb),0.04)' : 'var(--color-surface)'
              }}
            >
              <h3>{course.title}</h3>
              <p>Matière: {course.matiere}</p>
            </div>
          ))}
          {courses.length === 0 && <p>Aucun cours trouvé.</p>}
        </div>
      )}

      {detailLoading && <p>Chargement des détails...</p>}

      {selectedCourse && !detailLoading && (
        <div style={{ marginTop: '2rem', padding: '1rem', backgroundColor: 'var(--color-surface)', borderRadius: '8px' }}>
          <h3>{selectedCourse.title} - Détails</h3>
          <div style={{ marginBottom: '1rem' }}>
            <h4>Podcast</h4>
            <audio controls src={`http://localhost:3000${selectedCourse.podcast.audioUrl}`}>
              Votre navigateur ne supporte pas l'élément audio.
            </audio>
          </div>
          <div>
            <h4>Résumé</h4>
            <p style={{ whiteSpace: 'pre-wrap' }}>{selectedCourse.resume.text}</p>
          </div>
          <button onClick={() => setSelectedCourse(null)}>Fermer</button>
        </div>
      )}
    </div>
  );
};

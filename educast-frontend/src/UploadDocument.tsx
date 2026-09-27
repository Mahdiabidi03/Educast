import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';

export const UploadDocument: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [invalidContent, setInvalidContent] = useState<{ message: string } | null>(null);
  
  const [saveToLibrary, setSaveToLibrary] = useState<boolean>(false);
  const [matiere, setMatiere] = useState<string>('');
  const [matieresList, setMatieresList] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const fetchMatieres = async () => {
      try {
        const response = await axios.get('http://localhost:3000/matieres');
        setMatieresList(response.data);
        if (response.data.length > 0) {
          setMatiere(response.data[0]);
        }
      } catch (err) {
        console.error('Failed to fetch matieres', err);
      }
    };
    fetchMatieres();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      const extension = selectedFile.name.split('.').pop()?.toLowerCase();
      
      if (extension !== 'pdf' && extension !== 'pptx' && extension !== 'docx') {
        setError("Format non supporté. Veuillez uploader un fichier .pdf, .pptx ou .docx.");
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setFile(selectedFile);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setError(null);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      const extension = droppedFile.name.split('.').pop()?.toLowerCase();
      
      if (extension !== 'pdf' && extension !== 'pptx' && extension !== 'docx') {
        setError("Format non supporté. Veuillez uploader un fichier .pdf, .pptx ou .docx.");
        setFile(null);
        return;
      }
      setFile(droppedFile);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const pollSummary = async (documentId: string) => {
    try {
      const response = await axios.get(`http://localhost:3000/documents/${documentId}/summary`);
      
      if (response.data.status === 'done') {
        setLoading(false);
        setSummary(response.data.summary);
        if (response.data.provider) {
          setProvider(response.data.provider);
        }
      } else if (response.data.status === 'invalid_content') {
        setLoading(false);
        setInvalidContent({
          message: response.data.errorMessage ||
            'Le document ne contient pas assez de texte pédagogique exploitable pour générer un résumé.',
        });
      } else if (response.data.status === 'error' || response.data.status === 'failed') {
        setLoading(false);
        setError("Erreur lors de la génération du résumé.");
      } else {
        // Continue polling if status is 'pending' or 'processing'
        setTimeout(() => pollSummary(documentId), 3000);
      }
    } catch (err) {
      console.error(err);
      setLoading(false);
      setError("Erreur lors de la récupération du résumé (backend indisponible).");
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setSummary(null);
    setProvider(null);
    setInvalidContent(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('saveToLibrary', saveToLibrary.toString());
    formData.append('matiere', matiere);

    try {
      if (!saveToLibrary) {
        // Résumé rapide (synchronous, no DB persistence)
        const response = await axios.post('http://localhost:3000/documents/quick-summary', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        if (response.data.status === 'done') {
          setSummary(response.data.summary);
          if (response.data.provider) setProvider(response.data.provider);
        } else if (response.data.status === 'invalid_content') {
          setInvalidContent({
            message: response.data.errorMessage || 'Contenu non exploitable.',
          });
        } else {
          setError(response.data.errorMessage || 'Erreur lors de la génération du résumé.');
        }
        setLoading(false);
      } else {
        // Sauvegarde dans la bibliothèque (asynchronous generation later)
        const response = await axios.post('http://localhost:3000/documents/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });

        if (response.data.courseId || response.data.document?.id) {
          setSummary("Cours ajouté à la bibliothèque avec succès ! Vous pouvez générer le résumé depuis l'onglet Bibliothèque.");
          setLoading(false);
        } else {
          setLoading(false);
          setError("Erreur lors de la sauvegarde.");
        }
      }
    } catch (err: any) {
      console.error(err);
      setLoading(false);
      const msg = err.response?.data?.message || err.message || "Erreur lors de l'upload du fichier.";
      setError(msg);
    }
  };

  return (
    <div className="upload-container">
      <h2>Générer un Résumé</h2>
      
      <div 
        className="drop-zone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <p>{file ? file.name : "Glissez-déposez un fichier ici (.pdf, .pptx, .docx) ou cliquez pour sélectionner"}</p>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          accept=".pdf,.pptx,.docx"
          style={{ display: 'none' }} 
        />
      </div>

      <div style={{ margin: '1rem 0', display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'center' }}>
        <label>
          <input 
            type="checkbox" 
            checked={saveToLibrary} 
            onChange={(e) => setSaveToLibrary(e.target.checked)} 
          />
          Sauvegarder dans la bibliothèque de cours
        </label>
        
        {saveToLibrary && matieresList.length > 0 && (
          <label>
            Matière:
            <select 
              value={matiere} 
              onChange={(e) => setMatiere(e.target.value)}
              style={{ marginLeft: '0.5rem' }}
            >
              {matieresList.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      {invalidContent && (
        <div className="invalid-content-warning">
          <span className="invalid-content-icon">⚠️</span>
          <div>
            <strong>Contenu non exploitable</strong>
            <p>{invalidContent.message}</p>
          </div>
        </div>
      )}

      <button 
        className="upload-button" 
        onClick={handleUpload} 
        disabled={!file || loading}
      >
        {loading ? "Analyse en cours..." : "Générer le résumé"}
      </button>

      {summary && (
        <div className="summary-container">
          <h3>Résumé :</h3>
          <p className="summary-text">{summary}</p>
          {provider && (
            <p className="provider-info">Résumé généré via {provider}</p>
          )}
        </div>
      )}
    </div>
  );
};
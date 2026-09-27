import React, { useState, useEffect } from 'react';
import axios from 'axios';
import styles from './Login.module.css';

const API_BASE = 'http://localhost:3000';

export const ResetPassword: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Extract token from URL
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (t) setToken(t);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || !confirmPassword) {
      setError('Veuillez remplir tous les champs.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (!token) {
      setError('Jeton de réinitialisation manquant.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await axios.post(`${API_BASE}/auth/reset-password`, {
        token,
        newPassword,
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Erreur lors de la réinitialisation du mot de passe.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.loginWrapper}>
      <div className={styles.loginCard}>
        <div className={styles.brandHeader}>
          <div className={styles.brandMark}>E</div>
          <h1 className={styles.brandTitle}>EduCast</h1>
        </div>

        <div style={{ textAlign: 'center', marginBottom: '1.2rem' }}>
          <h2 style={{ margin: '0 0 6px', fontSize: '1.15rem', fontWeight: 800, color: 'var(--color-text)' }}>
            Nouveau mot de passe
          </h2>
        </div>

        {error && <div className={styles.errorBanner}>⚠️ {error}</div>}

        {success ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              padding: '1rem', borderRadius: '10px',
              background: 'rgba(16,185,129,0.1)',
              border: '1px solid rgba(16,185,129,0.25)',
              color: '#10b981', fontSize: '0.9rem', fontWeight: 600,
              marginBottom: '1rem',
            }}>
              ✅ Votre mot de passe a été réinitialisé avec succès.
            </div>
            <a href="/" style={{
              display: 'inline-block',
              width: '100%',
              padding: '0.75rem 1rem',
              borderRadius: '999px',
              background: 'var(--color-accent)',
              color: '#ffffff',
              fontSize: '0.9rem',
              fontWeight: 700,
              textAlign: 'center',
              textDecoration: 'none',
              boxSizing: 'border-box'
            }}>
              Retour à la connexion
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className={styles.formGroup}>
              <label htmlFor="newPassword">Nouveau mot de passe *</label>
              <div className={styles.passwordWrapper}>
                <input
                  id="newPassword"
                  type={showNewPassword ? 'text' : 'password'}
                  className={styles.formInput}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoFocus
                />
                <button
                  type="button"
                  className={styles.eyeToggleBtn}
                  onClick={() => setShowNewPassword((v) => !v)}
                  aria-label={showNewPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  tabIndex={-1}
                >
                  {showNewPassword ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div className={styles.formGroup}>
              <label htmlFor="confirmPassword">Confirmer le mot de passe *</label>
              <div className={styles.passwordWrapper}>
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  className={styles.formInput}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  className={styles.eyeToggleBtn}
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  aria-label={showConfirmPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  tabIndex={-1}
                >
                  {showConfirmPassword ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={loading || !token}
            >
              {loading ? 'Réinitialisation...' : 'Réinitialiser'}
            </button>
            {!token && (
              <p style={{ color: '#ef4444', fontSize: '0.8rem', textAlign: 'center', marginTop: '0.5rem' }}>
                Lien invalide ou expiré.
              </p>
            )}
            
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <a href="/" style={{
                color: 'var(--color-text-muted)', fontSize: '0.8rem',
                textDecoration: 'none', fontWeight: 600
              }}>
                ← Retour à la connexion
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

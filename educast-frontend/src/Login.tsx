import React, { useState } from 'react';
import axios from 'axios';
import styles from './Login.module.css';
import { setSession, UserSession } from './auth';

interface LoginProps {
  onLoginSuccess: (user: UserSession) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

const API_BASE = 'http://localhost:3000';

export const Login: React.FC<LoginProps> = ({ onLoginSuccess, theme, onToggleTheme }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const role: 'etudiant' | 'admin' = 'etudiant';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Verification code state ──
  const [verifyPhase, setVerifyPhase] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [codeDigits, setCodeDigits] = useState(['', '', '', '', '', '']);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resendSent, setResendSent] = useState(false);

  // ── Forgot Password state ──
  const [forgotPhase, setForgotPhase] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotSuccess, setForgotSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'login') {
      if (!email || !password) {
        setError('Veuillez saisir votre email et mot de passe.');
        return;
      }
      setLoading(true);
      try {
        const response = await axios.post<{
          accessToken?: string;
          user?: UserSession;
          requiresVerification?: boolean;
          email?: string;
        }>(`${API_BASE}/auth/login`, { email, password });

        if (response.data.requiresVerification) {
          // Show inline code entry
          setPendingEmail(response.data.email || email);
          setVerifyPhase(true);
          return;
        }

        setSession(response.data.accessToken!, response.data.user!);
        onLoginSuccess(response.data.user!);
      } catch (err: any) {
        console.error('Login failed', err);
        setError(
          err.response?.data?.message ??
            'Échec de connexion. Vérifiez vos identifiants.',
        );
      } finally {
        setLoading(false);
      }
    } else {
      // Register mode
      if (!name || !email || !password) {
        setError('Veuillez remplir tous les champs requis (Nom, Email, Mot de passe).');
        return;
      }
      setLoading(true);
      try {
        const response = await axios.post<{
          accessToken?: string;
          user?: UserSession;
          requiresVerification?: boolean;
          email?: string;
          message?: string;
        }>(`${API_BASE}/auth/register`, { name, email, password, role });

        if (response.data.requiresVerification) {
          setPendingEmail(response.data.email || email);
          setVerifyPhase(true);
          return;
        }

        // Fallback: if backend ever returns a token directly
        if (response.data.accessToken && response.data.user) {
          setSession(response.data.accessToken, response.data.user);
          onLoginSuccess(response.data.user);
        }
      } catch (err: any) {
        console.error('Register failed', err);
        setError(
          err.response?.data?.message ??
            'Création de compte échouée. Un compte existe peut-être déjà avec cet email.',
        );
      } finally {
        setLoading(false);
      }
    }
  };

  // ── Handle code digit inputs ──
  const handleDigitChange = (index: number, value: string) => {
    if (!/^\d?$/.test(value)) return; // only allow single digit
    const newDigits = [...codeDigits];
    newDigits[index] = value;
    setCodeDigits(newDigits);

    // Auto-focus next
    if (value && index < 5) {
      const next = document.getElementById(`code-digit-${index + 1}`) as HTMLInputElement;
      next?.focus();
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !codeDigits[index] && index > 0) {
      const prev = document.getElementById(`code-digit-${index - 1}`) as HTMLInputElement;
      prev?.focus();
    }
  };

  const handleDigitPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      setCodeDigits(pasted.split(''));
      const last = document.getElementById('code-digit-5') as HTMLInputElement;
      last?.focus();
    }
  };

  const handleVerifyCode = async () => {
    const code = codeDigits.join('');
    if (code.length !== 6) {
      setVerifyError('Veuillez entrer le code complet à 6 chiffres.');
      return;
    }
    setVerifyLoading(true);
    setVerifyError(null);
    try {
      const res = await axios.post<{ accessToken: string; user: UserSession }>(
        `${API_BASE}/auth/verify-email`,
        { email: pendingEmail, code },
      );
      setSession(res.data.accessToken, res.data.user);
      onLoginSuccess(res.data.user);
    } catch (err: any) {
      setVerifyError(err.response?.data?.message || 'Code invalide ou expiré.');
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleResendCode = async () => {
    setResendSent(false);
    setVerifyError(null);
    try {
      await axios.post(`${API_BASE}/auth/resend-verification`, { email: pendingEmail });
      setResendSent(true);
      setCodeDigits(['', '', '', '', '', '']);
    } catch (err: any) {
      setVerifyError(err.response?.data?.message || 'Erreur lors du renvoi.');
    }
  };



  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail) {
      setForgotError('Veuillez saisir votre email.');
      return;
    }
    setForgotLoading(true);
    setForgotError(null);
    try {
      await axios.post(`${API_BASE}/auth/forgot-password`, { email: forgotEmail });
      setForgotSuccess(true);
    } catch (err: any) {
      setForgotError(err.response?.data?.message || 'Erreur lors de la demande.');
    } finally {
      setForgotLoading(false);
    }
  };

  // ══════════════════════════════════════════════════════════
  //  FORGOT PASSWORD PHASE
  // ══════════════════════════════════════════════════════════
  if (forgotPhase) {
    return (
      <div className={styles.loginWrapper}>
        <div className={styles.topBar}>
          <button
            type="button"
            className={styles.themeToggleBtn}
            onClick={onToggleTheme}
            aria-label={`Activer le thème ${theme === 'light' ? 'sombre' : 'clair'}`}
          >
            <span>{theme === 'light' ? '☾' : '☀'}</span>
            <span>{theme === 'light' ? 'Thème Sombre' : 'Thème Clair'}</span>
          </button>
        </div>

        <div className={styles.loginCard}>
          <div className={styles.brandHeader}>
            <div className={styles.brandMark}>E</div>
            <h1 className={styles.brandTitle}>EduCast</h1>
            <p className={styles.brandSubtitle}>Studio Pédagogique Intelligente</p>
          </div>

          <div style={{ textAlign: 'center', marginBottom: '1.2rem' }}>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.15rem', fontWeight: 800, color: 'var(--color-text)' }}>
              Mot de passe oublié
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Entrez votre adresse email pour recevoir un lien de réinitialisation.
            </p>
          </div>

          {forgotError && <div className={styles.errorBanner}>⚠️ {forgotError}</div>}
          
          {forgotSuccess ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{
                padding: '1rem', borderRadius: '10px',
                background: 'rgba(16,185,129,0.1)',
                border: '1px solid rgba(16,185,129,0.25)',
                color: '#10b981', fontSize: '0.9rem', fontWeight: 600,
                marginBottom: '1rem',
              }}>
                ✅ Un lien de réinitialisation vous a été envoyé si cet email est associé à un compte.
              </div>
              <button
                type="button"
                onClick={() => {
                  setForgotPhase(false);
                  setForgotSuccess(false);
                  setForgotEmail('');
                }}
                className={styles.submitBtn}
                style={{ background: 'var(--color-surface-inset)', color: 'var(--color-text)', border: '1px solid var(--color-border)', boxShadow: 'none' }}
              >
                Retour à la connexion
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword}>
              <div className={styles.formGroup}>
                <label htmlFor="forgotEmail">Email *</label>
                <input
                  id="forgotEmail"
                  type="email"
                  className={styles.formInput}
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="votre.email@educast.fr"
                  required
                  autoFocus
                />
              </div>

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={forgotLoading}
              >
                {forgotLoading ? 'Envoi...' : 'Envoyer le lien'}
              </button>

              <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                <button
                  type="button"
                  onClick={() => {
                    setForgotPhase(false);
                    setForgotError(null);
                  }}
                  style={{
                    background: 'none', border: 'none',
                    color: 'var(--color-text-muted)', fontSize: '0.8rem',
                    cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  ← Retour à la connexion
                </button>
              </div>
            </form>
          )}

          <p className={styles.footerNote}>
            © 2026 EduCast — Accès sécurisé au studio pédagogique
          </p>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  //  VERIFY PHASE — inline code entry (same card, no redirect)
  // ══════════════════════════════════════════════════════════
  if (verifyPhase) {
    return (
      <div className={styles.loginWrapper}>
        <div className={styles.topBar}>
          <button
            type="button"
            className={styles.themeToggleBtn}
            onClick={onToggleTheme}
            aria-label={`Activer le thème ${theme === 'light' ? 'sombre' : 'clair'}`}
          >
            <span>{theme === 'light' ? '☾' : '☀'}</span>
            <span>{theme === 'light' ? 'Thème Sombre' : 'Thème Clair'}</span>
          </button>
        </div>

        <div className={styles.loginCard}>
          <div className={styles.brandHeader}>
            <div className={styles.brandMark}>E</div>
            <h1 className={styles.brandTitle}>EduCast</h1>
            <p className={styles.brandSubtitle}>Studio Pédagogique Intelligente</p>
          </div>

          {/* Icon + Title */}
          <div style={{ textAlign: 'center', marginBottom: '0.6rem' }}>
            <div style={{
              width: '56px', height: '56px', margin: '0 auto 12px',
              background: 'linear-gradient(135deg, rgba(124,58,237,0.15), rgba(79,70,229,0.1))',
              border: '2px solid rgba(124,58,237,0.35)',
              borderRadius: '16px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '28px',
            }}>🔐</div>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.15rem', fontWeight: 800, color: 'var(--color-text)' }}>
              Vérifiez votre email
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Un code à 6 chiffres a été envoyé à<br />
              <strong style={{ color: 'var(--color-accent)' }}>{pendingEmail}</strong>
            </p>
          </div>

          {/* 6-digit code inputs */}
          <div style={{
            display: 'flex', justifyContent: 'center', gap: '8px',
            margin: '20px 0 16px',
          }} onPaste={handleDigitPaste}>
            {codeDigits.map((digit, i) => (
              <input
                key={i}
                id={`code-digit-${i}`}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleDigitChange(i, e.target.value)}
                onKeyDown={(e) => handleDigitKeyDown(i, e)}
                autoFocus={i === 0}
                style={{
                  width: '46px', height: '56px',
                  textAlign: 'center',
                  fontSize: '1.5rem', fontWeight: 800,
                  borderRadius: '12px',
                  border: digit
                    ? '2px solid var(--color-accent)'
                    : '1.5px solid var(--color-border)',
                  background: 'var(--color-surface-inset)',
                  color: 'var(--color-text)',
                  outline: 'none',
                  transition: 'all 0.18s ease',
                  boxShadow: digit ? '0 0 0 3px rgba(124,58,237,0.12)' : 'none',
                  caretColor: 'var(--color-accent)',
                }}
              />
            ))}
          </div>

          {/* Error */}
          {verifyError && (
            <div className={styles.errorBanner}>⚠️ {verifyError}</div>
          )}

          {/* Resend success */}
          {resendSent && (
            <div style={{
              padding: '0.5rem 0.8rem', borderRadius: '10px',
              background: 'rgba(16,185,129,0.1)',
              border: '1px solid rgba(16,185,129,0.25)',
              color: '#10b981', fontSize: '0.8rem', fontWeight: 600,
              marginBottom: '0.8rem', textAlign: 'center',
            }}>✅ Nouveau code envoyé !</div>
          )}

          {/* Verify button */}
          <button
            type="button"
            className={styles.submitBtn}
            disabled={verifyLoading || codeDigits.join('').length !== 6}
            onClick={handleVerifyCode}
          >
            {verifyLoading ? '⏳ Vérification…' : '✅ Vérifier le code'}
          </button>

          {/* Resend / Back */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: '1rem', gap: '0.5rem',
          }}>
            <button
              type="button"
              onClick={() => {
                setVerifyPhase(false);
                setCodeDigits(['', '', '', '', '', '']);
                setVerifyError(null);
                setResendSent(false);
              }}
              style={{
                background: 'none', border: 'none',
                color: 'var(--color-text-muted)', fontSize: '0.78rem',
                cursor: 'pointer', fontWeight: 600,
                padding: '6px 0',
              }}
            >← Retour</button>
            <button
              type="button"
              onClick={handleResendCode}
              style={{
                background: 'none', border: 'none',
                color: 'var(--color-accent)', fontSize: '0.78rem',
                cursor: 'pointer', fontWeight: 600,
                padding: '6px 0',
              }}
            >📨 Renvoyer le code</button>
          </div>

          <p className={styles.footerNote}>
            © 2026 EduCast — Accès sécurisé au studio pédagogique
          </p>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════
  //  NORMAL LOGIN / REGISTER
  // ══════════════════════════════════════════════════════════
  return (
    <div className={styles.loginWrapper}>
      {/* Top right theme toggle button */}
      <div className={styles.topBar}>
        <button
          type="button"
          className={styles.themeToggleBtn}
          onClick={onToggleTheme}
          aria-label={`Activer le thème ${theme === 'light' ? 'sombre' : 'clair'}`}
          title={`Activer le thème ${theme === 'light' ? 'sombre' : 'clair'}`}
        >
          <span>{theme === 'light' ? '☾' : '☀'}</span>
          <span>{theme === 'light' ? 'Thème Sombre' : 'Thème Clair'}</span>
        </button>
      </div>

      {/* Centered Login Card */}
      <div className={styles.loginCard}>
        <div className={styles.brandHeader}>
          <div className={styles.brandMark}>E</div>
          <h1 className={styles.brandTitle}>EduCast</h1>
          <p className={styles.brandSubtitle}>Studio Pédagogique Intelligente</p>
        </div>

        {/* Tab switcher: Se connecter / Créer un compte */}
        <div className={styles.tabSwitch}>
          <button
            type="button"
            className={`${styles.tabBtn} ${mode === 'login' ? styles.tabBtnActive : ''}`}
            onClick={() => { setMode('login'); setError(null); }}
          >
            Se connecter
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${mode === 'register' ? styles.tabBtnActive : ''}`}
            onClick={() => { setMode('register'); setError(null); }}
          >
            Créer un compte
          </button>
        </div>



        {error && <div className={styles.errorBanner}>⚠️ {error}</div>}

        <form onSubmit={handleSubmit}>
          {mode === 'register' && (
            <div className={styles.formGroup}>
              <label htmlFor="name">Nom d'utilisateur / Nom complet *</label>
              <input
                id="name"
                type="text"
                className={styles.formInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Jean Dupont"
                required
              />
            </div>
          )}

          <div className={styles.formGroup}>
            <label htmlFor="email">Email *</label>
            <input
              id="email"
              type="email"
              className={styles.formInput}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="votre.email@educast.fr"
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="password">Mot de passe *</label>
            <div className={styles.passwordWrapper}>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className={styles.formInput}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                className={styles.eyeToggleBtn}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                tabIndex={-1}
              >
                {showPassword ? (
                  // Eye-off icon
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  // Eye icon
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {mode === 'login' && (
            <div style={{ textAlign: 'right', marginBottom: '0.5rem', marginTop: '-0.4rem' }}>
              <button
                type="button"
                className={styles.forgotPasswordLink}
                onClick={() => setForgotPhase(true)}
              >
                Mot de passe oublié ?
              </button>
            </div>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={loading}
          >
            {loading
              ? 'Traitement en cours…'
              : mode === 'login'
              ? 'Se connecter'
              : 'Créer mon compte'}
          </button>
        </form>

        <p className={styles.footerNote}>
          © 2026 EduCast — Accès sécurisé au studio pédagogique
        </p>
      </div>
    </div>
  );
};

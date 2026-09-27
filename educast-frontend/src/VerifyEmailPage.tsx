import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { setSession, UserSession } from './auth';

const API_BASE = 'http://localhost:3000';

type Phase = 'verifying' | 'success' | 'expired' | 'invalid' | 'check-email';

interface VerifyEmailPageProps {
  token?: string | null;
  pendingEmail?: string | null;
  onVerified: (user: UserSession) => void;
  onBackToLogin: () => void;
  theme: 'light' | 'dark';
}

export const VerifyEmailPage: React.FC<VerifyEmailPageProps> = ({
  token,
  pendingEmail,
  onVerified,
  onBackToLogin,
  theme,
}) => {
  const [phase, setPhase] = useState<Phase>(token ? 'verifying' : 'check-email');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendEmail, setResendEmail] = useState(pendingEmail || '');

  useEffect(() => {
    if (!token) return;
    const verify = async () => {
      try {
        const res = await axios.get<{ accessToken: string; user: UserSession }>(
          `${API_BASE}/auth/verify-email?token=${token}`
        );
        setSession(res.data.accessToken, res.data.user);
        setPhase('success');
        setTimeout(() => onVerified(res.data.user), 2200);
      } catch (err: any) {
        const msg: string = err.response?.data?.message || '';
        if (msg.toLowerCase().includes('expir')) {
          setPhase('expired');
        } else {
          setPhase('invalid');
        }
      }
    };
    verify();
  }, [token]);

  const handleResend = async () => {
    if (!resendEmail) return;
    setResendLoading(true);
    setResendError(null);
    try {
      await axios.post(`${API_BASE}/auth/resend-verification`, { email: resendEmail });
      setResendSent(true);
    } catch (err: any) {
      setResendError(err.response?.data?.message || 'Erreur lors de l\'envoi.');
    } finally {
      setResendLoading(false);
    }
  };

  const isDark = theme === 'dark';

  const bg = isDark
    ? 'linear-gradient(135deg, #0f0e1a 0%, #161430 100%)'
    : 'linear-gradient(135deg, #f0f0ff 0%, #e8e6ff 100%)';

  const cardBg = isDark ? 'rgba(22,20,43,0.95)' : '#ffffff';
  const cardBorder = isDark ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.15)';
  const textMain = isDark ? '#e9e8ff' : '#1a1830';
  const textMuted = isDark ? '#9d9ac2' : '#6b6894';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : '#f7f6ff';
  const inputBorder = isDark ? 'rgba(124,58,237,0.3)' : 'rgba(124,58,237,0.2)';

  const configs: Record<Phase, { icon: string; title: string; subtitle: string; accent: string; glow: string }> = {
    verifying: {
      icon: '⏳',
      title: 'Vérification en cours…',
      subtitle: 'Veuillez patienter, nous validons votre email.',
      accent: '#7c3aed',
      glow: 'rgba(124,58,237,0.3)',
    },
    success: {
      icon: '✅',
      title: 'Email vérifié !',
      subtitle: 'Votre compte est activé. Redirection automatique…',
      accent: '#10b981',
      glow: 'rgba(16,185,129,0.3)',
    },
    expired: {
      icon: '⏱',
      title: 'Lien expiré',
      subtitle: 'Ce lien de vérification a expiré. Demandez-en un nouveau ci-dessous.',
      accent: '#f59e0b',
      glow: 'rgba(245,158,11,0.3)',
    },
    invalid: {
      icon: '❌',
      title: 'Lien invalide',
      subtitle: 'Ce lien est invalide ou déjà utilisé. Vérifiez votre boîte mail.',
      accent: '#ef4444',
      glow: 'rgba(239,68,68,0.3)',
    },
    'check-email': {
      icon: '📧',
      title: 'Vérifiez votre email',
      subtitle: 'Un lien de vérification vous a été envoyé. Cliquez dessus pour activer votre compte.',
      accent: '#7c3aed',
      glow: 'rgba(124,58,237,0.3)',
    },
  };

  const cfg = configs[phase];
  const showResend = phase === 'check-email' || phase === 'expired' || phase === 'invalid';

  return (
    <div style={{
      minHeight: '100vh',
      width: '100vw',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: bg,
      fontFamily: "'Segoe UI', Inter, Arial, sans-serif",
      padding: '1rem',
      boxSizing: 'border-box',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '460px',
        background: cardBg,
        border: `1px solid ${cardBorder}`,
        borderRadius: '28px',
        padding: '48px 40px',
        boxShadow: `0 24px 64px rgba(0,0,0,0.35), 0 0 0 1px ${cardBorder}`,
        backdropFilter: 'blur(20px)',
        textAlign: 'center',
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '36px' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '12px',
            background: 'linear-gradient(135deg,#7c3aed,#4f46e5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '22px', fontWeight: '900', color: '#fff',
            boxShadow: '0 6px 18px rgba(124,58,237,0.35)',
          }}>E</div>
          <div>
            <div style={{ fontSize: '22px', fontWeight: '800', color: textMain, letterSpacing: '-0.5px' }}>EduCast</div>
            <div style={{ fontSize: '12px', color: textMuted, marginTop: '1px' }}>Studio Pédagogique Intelligente</div>
          </div>
        </div>

        {/* Big Icon */}
        <div style={{
          width: '80px', height: '80px', margin: '0 auto 24px',
          background: `linear-gradient(135deg,${cfg.accent}22,${cfg.accent}11)`,
          border: `2px solid ${cfg.accent}55`,
          borderRadius: '22px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '38px',
          boxShadow: `0 12px 32px ${cfg.glow}`,
          animation: phase === 'verifying' ? 'pulse 1.5s ease-in-out infinite' : undefined,
        }}>
          {cfg.icon}
        </div>

        {/* Title */}
        <h1 style={{ margin: '0 0 10px', fontSize: '24px', fontWeight: '800', color: textMain, letterSpacing: '-0.5px' }}>
          {cfg.title}
        </h1>

        {/* Subtitle */}
        <p style={{ margin: '0 0 32px', fontSize: '14px', color: textMuted, lineHeight: '1.7' }}>
          {cfg.subtitle}
        </p>

        {/* Success bar */}
        {phase === 'success' && (
          <div style={{
            height: '4px', borderRadius: '999px',
            background: `linear-gradient(90deg, #10b981, #059669)`,
            marginBottom: '24px',
            animation: 'grow 2s linear forwards',
          }} />
        )}

        {/* Resend section */}
        {showResend && !resendSent && (
          <div style={{ marginBottom: '24px' }}>
            <div style={{
              background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(124,58,237,0.04)',
              border: `1px solid ${inputBorder}`,
              borderRadius: '14px',
              padding: '20px',
              marginBottom: '16px',
            }}>
              <p style={{ margin: '0 0 14px', fontSize: '13px', fontWeight: '600', color: textMain }}>
                Renvoyer le lien de vérification
              </p>
              <input
                type="email"
                placeholder="Votre adresse email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                style={{
                  width: '100%', padding: '10px 14px',
                  border: `1px solid ${inputBorder}`,
                  borderRadius: '10px', background: inputBg,
                  color: textMain, fontSize: '14px',
                  outline: 'none', boxSizing: 'border-box',
                  marginBottom: '12px',
                }}
              />
              <button
                onClick={handleResend}
                disabled={resendLoading || !resendEmail}
                style={{
                  width: '100%', padding: '12px',
                  border: 'none', borderRadius: '10px',
                  background: resendLoading ? '#6b6894' : `linear-gradient(135deg,${cfg.accent},#4f46e5)`,
                  color: '#fff', fontWeight: '700', fontSize: '14px',
                  cursor: resendLoading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: `0 6px 16px ${cfg.glow}`,
                }}
              >
                {resendLoading ? '⏳ Envoi…' : '📨 Renvoyer le lien'}
              </button>
              {resendError && (
                <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#ef4444' }}>{resendError}</p>
              )}
            </div>
          </div>
        )}

        {/* Resend success */}
        {resendSent && (
          <div style={{
            background: 'rgba(16,185,129,0.08)',
            border: '1px solid rgba(16,185,129,0.25)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '24px',
            fontSize: '14px',
            color: '#10b981',
            fontWeight: '600',
          }}>
            ✅ Email envoyé ! Vérifiez votre boîte de réception.
          </div>
        )}

        {/* Back button */}
        <button
          onClick={onBackToLogin}
          style={{
            width: '100%', padding: '12px',
            border: `1px solid ${inputBorder}`,
            borderRadius: '12px',
            background: 'transparent',
            color: textMuted, fontWeight: '600', fontSize: '14px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = cfg.accent; e.currentTarget.style.color = cfg.accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = inputBorder; e.currentTarget.style.color = textMuted; }}
        >
          ← Retour à la connexion
        </button>

        <p style={{ marginTop: '20px', fontSize: '11px', color: textMuted }}>
          © 2026 EduCast — Accès sécurisé
        </p>
      </div>

      <style>{`
        @keyframes pulse {
          0%,100% { transform: scale(1); opacity:1; }
          50% { transform: scale(1.06); opacity:0.85; }
        }
        @keyframes grow {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
};

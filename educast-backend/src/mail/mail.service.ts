import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false, // STARTTLS
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  async sendVerificationEmail(to: string, name: string, code: string): Promise<void> {
    const fromName = process.env.SMTP_FROM_NAME || 'EduCast';
    const fromEmail = process.env.SMTP_USER;

    // Split the 6-digit code into individual digits for the beautiful display
    const digits = code.split('');
    const digitBoxes = digits
      .map(
        (d) => `
        <td style="
          width:48px;height:58px;
          background:#F3F4F6;
          border:2px solid #E5E7EB;
          border-radius:12px;
          text-align:center;vertical-align:middle;
          font-size:28px;font-weight:800;
          color:#111111;
          letter-spacing:0;
          font-family:'Inter','Segoe UI',Arial,sans-serif;
        ">${d}</td>`,
      )
      .join('\n        <td style="width:8px;"></td>\n');

    const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Votre code de vérification — EduCast</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#F7F7F8;font-family:'Inter','Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F8;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">

          <!-- Header / Brand -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#E30613,#B8050F);
                    border-radius:12px;
                    width:44px;height:44px;
                    text-align:center;vertical-align:middle;
                    font-size:22px;font-weight:800;color:#ffffff;
                    letter-spacing:-0.5px;
                    line-height:44px;
                    box-shadow:0 6px 18px rgba(227,6,19,0.22);
                  ">E</td>
                  <td style="padding-left:12px;">
                    <div style="font-size:22px;font-weight:800;color:#111111;letter-spacing:-0.02em;font-family:'Inter','Segoe UI',Arial,sans-serif;">EduCast</div>
                    <div style="font-size:12px;color:#6B7280;margin-top:1px;font-family:'Inter','Segoe UI',Arial,sans-serif;">Studio Pédagogique Intelligente</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="
              background:#FFFFFF;
              border-radius:20px;
              border:1px solid #E5E7EB;
              padding:40px 36px;
              box-shadow:0 18px 40px rgba(17,24,39,0.08);
            ">

              <!-- Icon -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <div style="
                      display:inline-block;
                      width:56px;height:56px;
                      background:rgba(227,6,19,0.08);
                      border:1px solid rgba(227,6,19,0.15);
                      border-radius:16px;
                      text-align:center;line-height:56px;
                      font-size:28px;
                    ">✉️</div>
                  </td>
                </tr>

                <!-- Heading -->
                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <h1 style="margin:0;font-size:22px;font-weight:800;color:#111111;letter-spacing:-0.02em;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      Votre code de vérification
                    </h1>
                  </td>
                </tr>

                <!-- Subtext -->
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <p style="margin:0;font-size:14px;color:#6B7280;line-height:1.6;max-width:400px;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      Bonjour <strong style="color:#111111;">${name}</strong>, bienvenue sur EduCast !<br/>
                      Saisissez ce code dans l'application pour activer votre compte.
                    </p>
                  </td>
                </tr>

                <!-- CODE DISPLAY — digit boxes matching app input style -->
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                      <tr>
                        ${digitBoxes}
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Copy-paste fallback -->
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <div style="
                      background:rgba(227,6,19,0.05);
                      border:1px dashed rgba(227,6,19,0.25);
                      border-radius:10px;
                      padding:10px 24px;
                      display:inline-block;
                    ">
                      <span style="color:#6B7280;font-size:12px;font-weight:600;font-family:'Inter','Segoe UI',Arial,sans-serif;">Code : </span>
                      <span style="color:#E30613;font-size:18px;font-weight:800;letter-spacing:6px;font-family:'Inter',monospace;">${code}</span>
                    </div>
                  </td>
                </tr>

                <!-- Expiry notice -->
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <div style="
                      background:rgba(251,191,36,0.08);
                      border:1px solid rgba(251,191,36,0.25);
                      border-radius:10px;
                      padding:10px 18px;
                      display:inline-block;
                    ">
                      <span style="color:#B45309;font-size:12px;font-family:'Inter','Segoe UI',Arial,sans-serif;">⏱ Ce code expire dans <strong>24 heures</strong></span>
                    </div>
                  </td>
                </tr>

                <!-- Divider -->
                <tr>
                  <td style="padding-bottom:20px;">
                    <div style="height:1px;background:#E5E7EB;"></div>
                  </td>
                </tr>

                <!-- Security note -->
                <tr>
                  <td align="center">
                    <p style="margin:0;font-size:11px;color:#9CA3AF;line-height:1.6;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      🛡️ Si vous n'avez pas demandé ce code, ignorez cet email.<br/>
                      Ne partagez jamais ce code avec quiconque.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:11px;color:#9CA3AF;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                Vous recevez cet email car vous avez créé un compte EduCast.<br/>
                Si ce n'est pas vous, ignorez simplement ce message.
              </p>
              <p style="margin:8px 0 0;font-size:10px;color:#D1D5DB;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                © 2026 EduCast — Studio Pédagogique Intelligente
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject: `🔐 Votre code EduCast : ${code}`,
        html: htmlBody,
      });
      this.logger.log(`[Mail] Verification code email sent to: ${to}`);
    } catch (err) {
      this.logger.error(`[Mail] Failed to send verification email to ${to}:`, err);
      throw err;
    }
  }

  async sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<void> {
    const fromName = process.env.SMTP_FROM_NAME || 'EduCast';
    const fromEmail = process.env.SMTP_USER;

    const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Réinitialisation de votre mot de passe — EduCast</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#F7F7F8;font-family:'Inter','Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F8;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="
                    background:linear-gradient(135deg,#E30613,#B8050F);
                    border-radius:12px;
                    width:44px;height:44px;
                    text-align:center;vertical-align:middle;
                    font-size:22px;font-weight:800;color:#ffffff;
                    letter-spacing:-0.5px;
                    line-height:44px;
                    box-shadow:0 6px 18px rgba(227,6,19,0.22);
                  ">E</td>
                  <td style="padding-left:12px;">
                    <div style="font-size:22px;font-weight:800;color:#111111;letter-spacing:-0.02em;font-family:'Inter','Segoe UI',Arial,sans-serif;">EduCast</div>
                    <div style="font-size:12px;color:#6B7280;margin-top:1px;font-family:'Inter','Segoe UI',Arial,sans-serif;">Studio Pédagogique Intelligente</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="
              background:#FFFFFF;
              border-radius:20px;
              border:1px solid #E5E7EB;
              padding:40px 36px;
              box-shadow:0 18px 40px rgba(17,24,39,0.08);
            ">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <div style="
                      display:inline-block;
                      width:56px;height:56px;
                      background:rgba(227,6,19,0.08);
                      border:1px solid rgba(227,6,19,0.15);
                      border-radius:16px;
                      text-align:center;line-height:56px;
                      font-size:28px;
                    ">🔑</div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:8px;">
                    <h1 style="margin:0;font-size:22px;font-weight:800;color:#111111;letter-spacing:-0.02em;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      Réinitialisation de mot de passe
                    </h1>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <p style="margin:0;font-size:14px;color:#6B7280;line-height:1.6;max-width:400px;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      Bonjour <strong style="color:#111111;">${name}</strong>,<br/>
                      Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour en créer un nouveau.
                    </p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <a href="${resetLink}" style="
                      display:inline-block;
                      background:#E30613;
                      color:#ffffff;
                      font-size:14px;
                      font-weight:700;
                      text-decoration:none;
                      padding:12px 24px;
                      border-radius:8px;
                      font-family:'Inter','Segoe UI',Arial,sans-serif;
                      box-shadow:0 4px 12px rgba(227,6,19,0.2);
                    ">
                      Réinitialiser mon mot de passe
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:24px;">
                    <div style="
                      background:rgba(251,191,36,0.08);
                      border:1px solid rgba(251,191,36,0.25);
                      border-radius:10px;
                      padding:10px 18px;
                      display:inline-block;
                    ">
                      <span style="color:#B45309;font-size:12px;font-family:'Inter','Segoe UI',Arial,sans-serif;">⏱ Ce lien expire dans <strong>1 heure</strong></span>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:20px;">
                    <div style="height:1px;background:#E5E7EB;"></div>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <p style="margin:0;font-size:11px;color:#9CA3AF;line-height:1.6;font-family:'Inter','Segoe UI',Arial,sans-serif;">
                      🛡️ Si vous n'avez pas demandé cette réinitialisation, veuillez ignorer cet email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject: `🔑 Réinitialisation de votre mot de passe EduCast`,
        html: htmlBody,
      });
      this.logger.log(`[Mail] Password reset email sent to: ${to}`);
    } catch (err) {
      this.logger.error(`[Mail] Failed to send password reset email to ${to}:`, err);
      throw err;
    }
  }
}

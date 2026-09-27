import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, UserRole } from './user.entity';
import { MailService } from '../mail/mail.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  /** Generate a random 6-digit verification code + expiry 24h from now */
  private generateVerificationToken(): { token: string; expiry: Date } {
    const code = String(Math.floor(100000 + crypto.randomInt(900000)));
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    return { token: code, expiry };
  }

  async register(
    email: string,
    password: string,
    name: string,
    role: UserRole = 'etudiant',
  ) {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('Un utilisateur avec cet email existe déjà.');
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const { token, expiry } = this.generateVerificationToken();

    const user = this.userRepository.create({
      email,
      name,
      passwordHash,
      role,
      emailVerified: false,
      verificationToken: token,
      verificationTokenExpiry: expiry,
    });

    const saved = await this.userRepository.save(user);

    // Send verification email (non-blocking — failure doesn't break registration)
    try {
      await this.mailService.sendVerificationEmail(saved.email, saved.name, token); // token is the 6-digit code
    } catch (mailErr) {
      console.error('[Auth] Failed to send verification email:', mailErr);
    }

    return {
      requiresVerification: true,
      message: 'Compte créé ! Vérifiez votre email pour activer votre compte.',
      email: saved.email,
    };
  }

  async login(email: string, password: string) {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Identifiants invalides.');
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Identifiants invalides.');
    }

    // Demo accounts (seeded) and existing accounts can log in without email verification
    const demoEmails = ['admin@educast.fr', 'etudiant@educast.fr', 'etudiant2@educast.fr'];
    if (!user.emailVerified && !demoEmails.includes(user.email)) {
      // Return a special flag so frontend can redirect to verify page
      return {
        requiresVerification: true,
        email: user.email,
        message: 'Veuillez vérifier votre adresse email avant de vous connecter.',
      };
    }

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: user.emailVerified,
      },
    };
  }

  async verifyEmail(email: string, code: string) {
    const user = await this.userRepository.findOne({ where: { email } });

    if (!user) {
      throw new NotFoundException('Aucun compte trouvé pour cet email.');
    }

    if (user.emailVerified) {
      throw new BadRequestException('Ce compte est déjà vérifié.');
    }

    if (!user.verificationToken || user.verificationToken !== code.trim()) {
      throw new BadRequestException('Code de vérification incorrect.');
    }

    if (user.verificationTokenExpiry && user.verificationTokenExpiry < new Date()) {
      throw new BadRequestException('Ce code a expiré. Veuillez en demander un nouveau.');
    }

    // Mark verified and clear code
    user.emailVerified = true;
    user.verificationToken = null;
    user.verificationTokenExpiry = null;
    await this.userRepository.save(user);

    // Issue JWT so user is immediately logged in after verifying
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: true,
      },
    };
  }

  async resendVerificationEmail(email: string) {
    const user = await this.userRepository.findOne({ where: { email } });

    if (!user) {
      // Don't leak whether email exists
      return { message: 'Si cet email est enregistré, un lien de vérification a été envoyé.' };
    }

    if (user.emailVerified) {
      throw new BadRequestException('Ce compte est déjà vérifié.');
    }

    const { token, expiry } = this.generateVerificationToken();
    user.verificationToken = token;
    user.verificationTokenExpiry = expiry;
    await this.userRepository.save(user);

    try {
      await this.mailService.sendVerificationEmail(user.email, user.name, token);
    } catch (mailErr) {
      console.error('[Auth] Failed to resend verification email:', mailErr);
      throw new BadRequestException('Impossible d\'envoyer l\'email. Réessayez plus tard.');
    }

    return { message: 'Email de vérification envoyé. Vérifiez votre boîte de réception.' };
  }

  async forgotPassword(email: string) {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      // Return success anyway to avoid email enumeration
      return { message: 'Si cet email correspond à un compte, un lien de réinitialisation vous a été envoyé.' };
    }

    const token = crypto.randomUUID();
    user.resetPasswordToken = token;
    user.resetPasswordTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await this.userRepository.save(user);

    const resetLink = `http://localhost:5173/reset-password?token=${token}`;
    try {
      await this.mailService.sendPasswordResetEmail(user.email, user.name, resetLink);
    } catch (err) {
      console.error('[Auth] Failed to send reset email:', err);
      // Still return success message
    }

    return { message: 'Si cet email correspond à un compte, un lien de réinitialisation vous a été envoyé.' };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.userRepository.findOne({ where: { resetPasswordToken: token } });

    if (!user || !user.resetPasswordTokenExpiry || user.resetPasswordTokenExpiry < new Date()) {
      throw new BadRequestException('Le lien de réinitialisation est invalide ou a expiré.');
    }

    const saltRounds = 10;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    user.resetPasswordToken = null;
    user.resetPasswordTokenExpiry = null;
    await this.userRepository.save(user);

    return { message: 'Votre mot de passe a été mis à jour avec succès.' };
  }

  async seedDefaultUsers() {
    const adminEmail = 'admin@educast.fr';
    const etudiantEmail = 'etudiant@educast.fr';
    const etudiant2Email = 'etudiant2@educast.fr';

    const hasAdmin = await this.userRepository.findOne({
      where: { email: adminEmail },
    });
    if (!hasAdmin) {
      const passwordHash = await bcrypt.hash('admin123', 10);
      await this.userRepository.save(
        this.userRepository.create({
          email: adminEmail,
          name: 'M. El Amari (Admin)',
          passwordHash,
          role: 'admin',
          emailVerified: true,
        }),
      );
      console.log('[Auth] Account seeded: admin@educast.fr / admin123');
    } else if (!hasAdmin.emailVerified) {
      // Backfill existing demo accounts as verified
      hasAdmin.emailVerified = true;
      await this.userRepository.save(hasAdmin);
    }

    const hasEtudiant = await this.userRepository.findOne({
      where: { email: etudiantEmail },
    });
    if (!hasEtudiant) {
      const passwordHash = await bcrypt.hash('etudiant123', 10);
      await this.userRepository.save(
        this.userRepository.create({
          email: etudiantEmail,
          name: 'Étudiant Demo 1',
          passwordHash,
          role: 'etudiant',
          emailVerified: true,
        }),
      );
      console.log('[Auth] Account seeded: etudiant@educast.fr / etudiant123');
    } else if (!hasEtudiant.emailVerified) {
      hasEtudiant.emailVerified = true;
      await this.userRepository.save(hasEtudiant);
    }

    const hasEtudiant2 = await this.userRepository.findOne({
      where: { email: etudiant2Email },
    });
    if (!hasEtudiant2) {
      const passwordHash = await bcrypt.hash('etudiant123', 10);
      await this.userRepository.save(
        this.userRepository.create({
          email: etudiant2Email,
          name: 'Étudiant Demo 2',
          passwordHash,
          role: 'etudiant',
          emailVerified: true,
        }),
      );
      console.log('[Auth] Account seeded: etudiant2@educast.fr / etudiant123');
    } else if (!hasEtudiant2.emailVerified) {
      hasEtudiant2.emailVerified = true;
      await this.userRepository.save(hasEtudiant2);
    }
  }
}

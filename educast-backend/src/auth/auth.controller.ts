import { Body, Controller, Get, Post, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserRole } from './user.entity';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    const { email, password } = body;
    if (!email || !password) {
      throw new Error('Email et mot de passe requis.');
    }
    return this.authService.login(email, password);
  }

  @Post('register')
  register(
    @Body() body: { email?: string; password?: string; name?: string; role?: UserRole },
  ) {
    const { email, password, name, role } = body;
    if (!email || !password || !name) {
      throw new Error('Email, mot de passe et nom requis.');
    }
    return this.authService.register(email, password, name, role ?? 'etudiant');
  }

  @Post('verify-email')
  verifyEmail(@Body() body: { email?: string; code?: string }) {
    const { email, code } = body;
    if (!email || !code) {
      throw new Error('Email et code requis.');
    }
    return this.authService.verifyEmail(email, code);
  }

  @Post('resend-verification')
  resendVerification(@Body() body: { email?: string }) {
    const { email } = body;
    if (!email) {
      throw new Error('Email requis.');
    }
    return this.authService.resendVerificationEmail(email);
  }

  @Post('forgot-password')
  forgotPassword(@Body() body: { email?: string }) {
    const { email } = body;
    if (!email) {
      throw new Error('Email requis.');
    }
    return this.authService.forgotPassword(email);
  }

  @Post('reset-password')
  resetPassword(@Body() body: { token?: string; newPassword?: string }) {
    const { token, newPassword } = body;
    if (!token || !newPassword) {
      throw new Error('Jeton et nouveau mot de passe requis.');
    }
    return this.authService.resetPassword(token, newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getProfile(@Request() req: any) {
    return req.user;
  }
}

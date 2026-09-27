import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from './user.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // No role restriction
    }

    const { user } = context.switchToHttp().getRequest<{ user?: { role: UserRole } }>();

    if (!user) {
      throw new ForbiddenException('Accès refusé — utilisateur non authentifié.');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Accès refusé — rôle requis : ${requiredRoles.join(', ')}. Votre rôle : ${user.role}.`,
      );
    }

    return true;
  }
}

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type UserRole = 'admin' | 'etudiant';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255, unique: true })
  email: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text' })
  passwordHash: string;

  @Column({ type: 'varchar', length: 20, default: 'etudiant' })
  role: UserRole;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  verificationToken: string | null;

  @Column({ type: 'timestamp', nullable: true, default: null })
  verificationTokenExpiry: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  resetPasswordToken: string | null;

  @Column({ type: 'timestamp', nullable: true, default: null })
  resetPasswordTokenExpiry: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}

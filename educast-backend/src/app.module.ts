import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { Document } from './documents/document.entity';
import { Matiere } from './matieres/matiere.entity';
import { User } from './auth/user.entity';
import { DocumentsModule } from './documents/documents.module';
import { CoursesModule } from './courses/courses.module';
import { MatieresModule } from './matieres/matieres.module';
import { AuthModule } from './auth/auth.module';


@Module({
  imports: [
    // ── Environment variables ──────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // ── PostgreSQL via TypeORM ────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        entities: [Document, Matiere, User],
        synchronize: true, // auto-creates tables — disable in production
        logging: false,
      }),
    }),

    // ── MongoDB via Mongoose ──────────────────────────────────────────────
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
        connectionFactory: (connection) => {
          connection.on('connected', () => {
            console.log('[MongoDB] Connected successfully to MongoDB');
          });
          connection.on('error', (error) => {
            console.error('[MongoDB] Connection error:', error);
          });
          return connection;
        },
      }),
    }),

    // ── Feature modules ───────────────────────────────────────────────────
    AuthModule,
    DocumentsModule,
    CoursesModule,
    MatieresModule,
  ],
})
export class AppModule {}

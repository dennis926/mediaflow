import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

export interface DatabaseEnv {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export function readDatabaseEnv(env: NodeJS.ProcessEnv): DatabaseEnv {
  return {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    username: env.DB_USER ?? 'mediaflow',
    password: env.DB_PASSWORD ?? 'mediaflow_dev',
    database: env.DB_NAME ?? 'mediaflow',
  };
}

/** Shared between the Nest runtime and the TypeORM CLI so both always see the same schema rules. */
export function buildDataSourceOptions(env: NodeJS.ProcessEnv): DataSourceOptions {
  const database = readDatabaseEnv(env);
  return {
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    namingStrategy: new SnakeNamingStrategy(),
    uuidExtension: 'pgcrypto',
    synchronize: false,
    logging: env.DB_LOGGING === 'true',
    entities: [join(__dirname, '../**/*.entity{.ts,.js}')],
    migrations: [join(__dirname, 'migrations/*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
  };
}

export function buildNestDataSourceOptions(config: ConfigService): TypeOrmModuleOptions {
  const database = readDatabaseEnv(process.env);
  return {
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    namingStrategy: new SnakeNamingStrategy(),
    uuidExtension: 'pgcrypto',
    synchronize: false,
    // Entities are registered by DatabaseModule and picked up here, which keeps class identity
    // intact (the CLI data source uses a glob because it runs outside Nest).
    autoLoadEntities: true,
    migrations: [join(__dirname, 'migrations/*{.ts,.js}')],
    migrationsTableName: 'typeorm_migrations',
    logging: config.get<string>('DB_LOGGING') === 'true',
  };
}

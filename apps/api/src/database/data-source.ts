import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.config';

// The CLI runs from apps/api, while configuration lives in the repository root.
loadEnv({ path: join(__dirname, '../../../../.env') });
loadEnv();

/** Single default export: the TypeORM CLI rejects data source files with several exports. */
const AppDataSource = new DataSource(buildDataSourceOptions(process.env));

export default AppDataSource;

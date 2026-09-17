import 'reflect-metadata';
import { register } from 'ts-node';

/**
 * TypeORM loads entity files through require(); register ts-node so the .ts sources used by the
 * glob in database.config.ts can be required inside the test process.
 */
register({
  transpileOnly: true,
  project: 'tsconfig.json',
  compilerOptions: { module: 'commonjs', target: 'ES2022' },
});

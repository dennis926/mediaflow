import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ALL_ENTITIES } from './entities';

/**
 * Registers every entity once so `autoLoadEntities` can pick them up.
 * Loading by class keeps entity identity stable (which a glob cannot guarantee under vitest).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature(ALL_ENTITIES)],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

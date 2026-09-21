import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Content } from '../content/entities/content.entity';
import { ContentReview } from '../content/entities/content-review.entity';
import { User } from '../workspace/entities/user.entity';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Content, ContentReview])],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}

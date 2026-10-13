import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import * as path from 'path';
import { ActivityService } from './dc/activity.service';
import { DcController } from './dc/dc.controller';
import { DcService } from './dc/dc.service';
import { JobQueueService } from './dc/job-queue.service';
import { RemoteRunnerService } from './dc/remote-runner.service';
import { SshPoolService } from './dc/ssh-pool.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    // Serves the built React app (frontend/dist) in production mode.
    ServeStaticModule.forRoot({
      rootPath: path.join(__dirname, '..', '..', 'frontend', 'dist'),
      exclude: ['/api/{*path}'],
    }),
  ],
  controllers: [DcController],
  providers: [ActivityService, SshPoolService, RemoteRunnerService, DcService, JobQueueService],
})
export class AppModule {}

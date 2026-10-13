import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ActivityService } from './activity.service';
import { Action, DcService } from './dc.service';
import { JobQueueService } from './job-queue.service';
import { SshPoolService } from './ssh-pool.service';

class EnqueueDto {
  policies: string[];
  action: Action;
  pgPassword?: string;
}

@Controller('api')
export class DcController {
  constructor(
    private readonly dc: DcService,
    private readonly queue: JobQueueService,
    private readonly pool: SshPoolService,
    private readonly activity: ActivityService,
  ) {}

  /** Slow-ish (shells out to gcloud for an auth check); the UI calls it on load / refresh. */
  @Get('status')
  status() {
    return this.dc.status();
  }

  /** Cheap snapshot the UI polls: session states/activity, all jobs, and log events after `since`. */
  @Get('jobs')
  jobs(@Query('since') since?: string) {
    return {
      sessions: this.pool.info(),
      pending: this.queue.pending,
      jobs: this.queue.list(),
      events: this.activity.recent(Number(since) || 0),
      lastSeq: this.activity.lastSeq, // lets the UI notice a server restart (seq goes backwards)
    };
  }

  @Post('jobs')
  enqueue(@Body() body: EnqueueDto) {
    return this.queue.enqueue(body.policies, body.action, body.pgPassword);
  }

  @Post('jobs/cancel')
  cancel() {
    return { cancelled: this.queue.cancelQueued() };
  }

  @Delete('jobs')
  clear() {
    this.queue.clearFinished();
    return { ok: true };
  }

  /** Retry sessions that failed; per-session state + lastError carry the outcome. */
  @Post('session/reconnect')
  async reconnect() {
    await this.pool.reconnectFailed();
    return this.pool.info();
  }

  @Get('files')
  files() {
    return this.dc.listFiles();
  }

  @Get('files/:name')
  download(@Param('name') name: string, @Res() res: Response) {
    res.download(this.dc.filePath(name), name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'file not found' });
    });
  }
}

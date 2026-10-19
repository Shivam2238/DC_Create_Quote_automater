import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ActivityService } from './activity.service';
import { Action, DcService } from './dc.service';
import { JobQueueService } from './job-queue.service';
import { MAX_AUTO_RETRIES, MAX_SESSIONS, SettingsService } from './settings.service';
import { SshPoolService } from './ssh-pool.service';

class CreateBatchDto {
  policies: string[];
  action: Action;
  name?: string;
  pgPassword?: string;
}

class RetryDto {
  /** Specific jobs to retry; omit to retry every connection/server failure in the batch. */
  jobIds?: string[];
  pgPassword?: string;
}

@Controller('api')
export class DcController {
  constructor(
    private readonly dc: DcService,
    private readonly queue: JobQueueService,
    private readonly pool: SshPoolService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
  ) {}

  /** Slow-ish (shells out to gcloud for an auth check); the UI calls it on load / refresh. */
  @Get('status')
  status() {
    return this.dc.status();
  }

  /**
   * Cheap snapshot the UI polls: sessions, batch summaries, the jobs of the batch
   * being viewed (`batch`), and log events after `since`.
   */
  @Get('state')
  state(@Query('since') since?: string, @Query('batch') batch?: string) {
    let selected: ReturnType<JobQueueService['get']> | null = null;
    try {
      selected = batch ? this.queue.get(batch) : null;
    } catch {
      selected = null; // deleted meanwhile
    }
    return {
      sessions: this.pool.info(),
      pending: this.queue.pending,
      vmBusy: this.queue.vmBusy,
      settings: { ...this.settings.get(), maxSessions: MAX_SESSIONS, maxAutoRetries: MAX_AUTO_RETRIES },
      batches: this.queue.summaries(),
      selected,
      events: this.activity.recent(Number(since) || 0),
      lastSeq: this.activity.lastSeq, // lets the UI notice a server restart (seq goes backwards)
    };
  }

  @Post('batches')
  createBatch(@Body() body: CreateBatchDto) {
    return this.queue.create(body.policies, body.action, body.name, body.pgPassword);
  }

  @Get('batches/:id')
  batch(@Param('id') id: string) {
    return this.queue.get(id);
  }

  @Patch('batches/:id')
  rename(@Param('id') id: string, @Body() body: { name: string }) {
    return this.queue.rename(id, body.name);
  }

  @Delete('batches/:id')
  remove(@Param('id') id: string) {
    this.queue.remove(id);
    return { ok: true };
  }

  @Post('batches/:id/cancel')
  cancel(@Param('id') id: string) {
    return { cancelled: this.queue.cancel(id) };
  }

  /** Stop one policy (running or queued); `requeue` puts it at the back of the queue. */
  @Post('batches/:id/jobs/:jobId/stop')
  stop(@Param('id') id: string, @Param('jobId') jobId: string, @Body() body: { requeue?: boolean }) {
    return this.queue.stop(id, jobId, !!body?.requeue);
  }

  /** Fetch the latest api_logs request/response for failed policies (no new create-quote call). */
  @Post('batches/:id/db-logs')
  dbLogs(@Param('id') id: string, @Body() body: { jobIds?: string[]; pgPassword?: string }) {
    return this.queue.fetchDbLogs(id, body?.jobIds, body?.pgPassword);
  }

  @Post('batches/:id/retry')
  retry(@Param('id') id: string, @Body() body: RetryDto) {
    return this.queue.retry(id, body.jobIds, body.pgPassword);
  }

  @Get('settings')
  getSettings() {
    return { ...this.settings.get(), maxSessions: MAX_SESSIONS, maxAutoRetries: MAX_AUTO_RETRIES };
  }

  /** Change concurrency (1-8) and/or auto-retries at runtime; applies immediately. */
  @Patch('settings')
  updateSettings(@Body() body: { concurrency?: number; autoRetries?: number }) {
    return { ...this.queue.setSettings(body ?? {}), maxSessions: MAX_SESSIONS, maxAutoRetries: MAX_AUTO_RETRIES };
  }

  /** Drop all SSH sessions and log in to the VM again (running policies are re-queued). */
  @Post('vm/reconnect')
  async vmReconnect() {
    return { result: await this.queue.reconnectVm(), sessions: this.pool.info() };
  }

  /** Close all SSH sessions (only when nothing is running or queued). */
  @Post('vm/disconnect')
  vmDisconnect() {
    return { result: this.queue.disconnectVm(), sessions: this.pool.info() };
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

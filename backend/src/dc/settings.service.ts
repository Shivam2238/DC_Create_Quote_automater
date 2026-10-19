import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';

// sshd's default MaxStartups is 10:30:100 (it starts dropping unauthenticated
// connections beyond 10), so stay well below that.
export const MAX_SESSIONS = 8;
export const MAX_AUTO_RETRIES = 5;

export interface Settings {
  /** Parallel SSH sessions = policies processed at once (1..MAX_SESSIONS). */
  concurrency: number;
  /** Automatic retries for transient create-quote errors (deadlock, E012, 502/503/504). */
  autoRetries: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));

/**
 * Runtime settings changed from the UI, persisted to DC_DATA_DIR/settings.json.
 * First-run defaults come from .env (DC_SESSIONS, DC_AUTO_RETRIES).
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private current: Settings;

  constructor(private readonly config: ConfigService) {
    const defaults: Settings = {
      concurrency: clamp(Number(config.get('DC_SESSIONS')) || 4, 1, MAX_SESSIONS),
      autoRetries: clamp(Number(config.get('DC_AUTO_RETRIES') ?? 2) || 0, 0, MAX_AUTO_RETRIES),
    };
    this.current = { ...defaults, ...this.load() };
  }

  private get file(): string {
    const dir = this.config.get<string>('DC_DATA_DIR') || path.join(__dirname, '..', '..', '..', 'data');
    return path.join(path.resolve(dir), 'settings.json');
  }

  private load(): Partial<Settings> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>;
    } catch (e) {
      this.logger.error(`could not read ${this.file}: ${(e as Error).message}`);
      return {};
    }
  }

  get(): Settings {
    return { ...this.current };
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current };
    if (patch.concurrency !== undefined) {
      const n = Number(patch.concurrency);
      if (!Number.isFinite(n) || n < 1 || n > MAX_SESSIONS) throw new BadRequestException(`concurrency must be 1-${MAX_SESSIONS}`);
      next.concurrency = clamp(n, 1, MAX_SESSIONS);
    }
    if (patch.autoRetries !== undefined) {
      const n = Number(patch.autoRetries);
      if (!Number.isFinite(n) || n < 0 || n > MAX_AUTO_RETRIES) throw new BadRequestException(`autoRetries must be 0-${MAX_AUTO_RETRIES}`);
      next.autoRetries = clamp(n, 0, MAX_AUTO_RETRIES);
    }
    this.current = next;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.logger.error(`could not save settings: ${(e as Error).message}`);
    }
    return this.get();
  }
}

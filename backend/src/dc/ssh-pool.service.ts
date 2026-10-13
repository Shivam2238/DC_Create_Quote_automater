import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityService, SessionActivity } from './activity.service';
import { SshSession } from './ssh-session.service';

const DEFAULT_SESSIONS = 4;
// sshd's default MaxStartups is 10:30:100 (it starts dropping unauthenticated
// connections beyond 10), so stay well below that.
const MAX_SESSIONS = 8;

export interface SessionInfo {
  id: number;
  state: SshSession['state'];
  lastError: string;
  connectedAt?: string;
  activity: SessionActivity;
}

/**
 * Pool of N long-lived SSH sessions to the VM (DC_SESSIONS, default 4).
 *
 * - Session #1 connects at startup; the others open lazily, only when the queue
 *   has enough work to need them.
 * - The others always wait until #1 has connected once. On a first run, gcloud
 *   may need to push the SSH key to metadata, and several gcloud processes doing
 *   that at the same time conflict.
 */
@Injectable()
export class SshPoolService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SshPoolService.name);
  readonly sessions: SshSession[];
  private primed = false;

  constructor(
    config: ConfigService,
    private readonly activity: ActivityService,
  ) {
    const n = Math.min(MAX_SESSIONS, Math.max(1, Math.floor(Number(config.get('DC_SESSIONS')) || DEFAULT_SESSIONS)));
    const first = new SshSession(1, config, activity);
    const waitForFirst = async () => {
      if (this.primed) return;
      await first.connect();
      this.primed = true;
    };
    this.sessions = [first, ...Array.from({ length: n - 1 }, (_, i) => new SshSession(i + 2, config, activity, waitForFirst))];
    for (const s of this.sessions) activity.set(s.id, 'disconnected', 'Not opened yet (opens when the queue needs it)');
    this.logger.log(`pool size ${n}`);
  }

  get size(): number {
    return this.sessions.length;
  }

  onApplicationBootstrap() {
    // Don't block startup: if auth has expired the UI still loads and shows why.
    this.sessions[0]
      .connect()
      .then(() => (this.primed = true))
      .catch((e) => this.logger.warn(`initial SSH connect failed: ${e.message}`));
  }

  onModuleDestroy() {
    for (const s of this.sessions) s.close();
  }

  /** Close every session (killing anything running on them). They reopen on demand. */
  disconnectAll(reason: string, label = 'Disconnected; reconnects when needed') {
    for (const s of this.sessions) {
      s.abort(reason);
      this.activity.set(s.id, 'disconnected', label);
    }
    // Next connect goes through #1 first again (fresh login before the others).
    this.primed = false;
  }

  /** Log in again on session #1; the others follow lazily when the queue needs them. */
  async connectFirst(): Promise<void> {
    await this.sessions[0].connect();
    this.primed = true;
  }

  /** Retry sessions that are down after a failure (sessions never opened stay lazy). */
  async reconnectFailed(): Promise<void> {
    const targets = this.sessions.filter(
      (s, i) => s.state === 'disconnected' && (s.lastError || (i === 0 && !this.primed)),
    );
    // #1 first, so the key-propagation rule above still holds.
    for (const s of targets.filter((t) => t.id === 1)) await s.connect().catch(() => undefined);
    await Promise.all(targets.filter((t) => t.id !== 1).map((s) => s.connect().catch(() => undefined)));
    if (this.sessions.some((s) => s.state === 'connected')) this.primed = true;
  }

  info(): SessionInfo[] {
    return this.sessions.map((s) => ({
      id: s.id,
      state: s.state,
      lastError: s.lastError,
      connectedAt: s.connectedAt?.toISOString(),
      activity: this.activity.get(s.id),
    }));
  }
}

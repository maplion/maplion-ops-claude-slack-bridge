import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type ThreadStatus = "active" | "idle" | "ended";

export type ThreadRef = {
  threadTs: string;
  channel: string;
  cwd: string;
  /** SDK session ID. null until first message in the session emits one. */
  sessionId: string | null;
  createdAt: number;
  lastActivity: number;
  status: ThreadStatus;
};

const STORE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "maplion-ops-claude-slack-bridge",
);
const STORE_PATH = path.join(STORE_DIR, "threads.json");
const LOCK_PATH = path.join(STORE_DIR, "bridge.lock");

/**
 * On-disk persistence for thread → session_id mappings.
 *
 * - Atomic writes via tmp+rename
 * - Debounced (250ms) so high-frequency updates coalesce
 * - Single-instance enforced via PID lockfile (refuses to start if another live PID holds it)
 *
 * The actual conversation history is owned by the Claude Code CLI in
 * ~/.claude/projects/. This store only tracks which session_id belongs to
 * which Slack thread.
 */
export class SessionStore {
  private refs: Map<string, ThreadRef> = new Map();
  private writeTimer: NodeJS.Timeout | null = null;
  private pendingWrite: Promise<void> | null = null;

  async init(): Promise<void> {
    await fs.mkdir(STORE_DIR, { recursive: true });
    await this.acquireLock();
    await this.load();
  }

  private async acquireLock(): Promise<void> {
    try {
      const handle = await fs.open(LOCK_PATH, "wx");
      await handle.write(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // Lockfile exists — check if its owner is alive
    const existing = await fs.readFile(LOCK_PATH, "utf-8").catch(() => "");
    const pid = parseInt(existing.trim(), 10);
    if (pid && pid !== process.pid && processAlive(pid)) {
      throw new Error(
        `Another bridge instance is running (pid=${pid}). Refusing to start. ` +
          `If this is wrong, remove ${LOCK_PATH} manually.`,
      );
    }
    // Stale lock — take it over
    await fs.writeFile(LOCK_PATH, `${process.pid}\n`);
  }

  async releaseLock(): Promise<void> {
    try {
      const existing = await fs.readFile(LOCK_PATH, "utf-8").catch(() => "");
      const pid = parseInt(existing.trim(), 10);
      if (pid === process.pid) await fs.unlink(LOCK_PATH);
    } catch {
      /* ignore */
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(STORE_PATH, "utf-8");
      const parsed = JSON.parse(data) as Record<string, ThreadRef>;
      this.refs = new Map(Object.entries(parsed));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // first run
      console.error("[store] load failed, starting empty:", err);
      this.refs = new Map();
    }
  }

  get(threadTs: string): ThreadRef | undefined {
    return this.refs.get(threadTs);
  }

  upsert(ref: ThreadRef): void {
    this.refs.set(ref.threadTs, ref);
    this.scheduleWrite();
  }

  delete(threadTs: string): void {
    if (this.refs.delete(threadTs)) this.scheduleWrite();
  }

  all(): readonly ThreadRef[] {
    return Array.from(this.refs.values());
  }

  size(): number {
    return this.refs.size;
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.pendingWrite = this.write().catch((err) => {
        console.error("[store] write failed:", err);
      });
    }, 250);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pendingWrite) await this.pendingWrite;
    await this.write();
  }

  private async write(): Promise<void> {
    const obj: Record<string, ThreadRef> = {};
    for (const [k, v] of this.refs) obj[k] = v;
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, STORE_PATH);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const STORE_PATHS = { STORE_DIR, STORE_PATH, LOCK_PATH };

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Channel } from '../types.js';
import { newSeed } from '../nmos/resources.js';
import { log } from '../util/log.js';

const DEFAULT_DIR = process.env.CONFIG_DIR ?? './config';

/** IS-05 state of a virtual receiver. */
export interface ConnectionState {
  sender_id: string | null;
  master_enable: boolean;
  transport_file: { data: string | null; type: string | null };
  transport_params: Record<string, unknown>[];
}

export const emptyConnection = (): ConnectionState => ({
  sender_id: null,
  master_enable: false,
  transport_file: { data: null, type: null },
  transport_params: [{}],
});

export interface PersistedState {
  /** Namespace for all deterministic UUIDs. Generated once, never changed. */
  seed: string;
  channels: Channel[];
  /** IS-05 staged/active per virtual receiver (our internal ID). */
  connections: Record<string, { staged: ConnectionState; active: ConnectionState }>;
}

/** Runtime state, kept apart from the configuration: resetting settings must not
 *  take the channel bookkeeping with it. */
export class StateStore {
  private state: PersistedState = { seed: newSeed(), channels: [], connections: {} };
  private writing: Promise<void> = Promise.resolve();

  /** Directory for state.json; overridable in tests. */
  constructor(private readonly dir: string = DEFAULT_DIR) {}

  get current(): PersistedState {
    return this.state;
  }

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(join(this.dir, 'state.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        seed: parsed.seed ?? newSeed(),
        channels: parsed.channels ?? [],
        connections: parsed.connections ?? {},
      };
      log.info({ channels: this.state.channels.length }, 'state loaded');
    } catch {
      log.info({}, 'no state found, starting empty');
      await this.save();
    }
    return this.state;
  }

  /** Writes atomically and serialised — concurrent calls do not clobber each other. */
  save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, 'state.json.tmp');
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmp, join(this.dir, 'state.json'));
    });
    return this.writing;
  }

  /** Back to empty, with a fresh seed — all deterministic IDs change with it. */
  async reset(): Promise<void> {
    this.state = { seed: newSeed(), channels: [], connections: {} };
    await this.save();
    log.info({}, 'state reset');
  }

  connection(receiverId: string): { staged: ConnectionState; active: ConnectionState } {
    this.state.connections[receiverId] ??= { staged: emptyConnection(), active: emptyConnection() };
    return this.state.connections[receiverId]!;
  }

  channelFor(receiverId: string): Channel | undefined {
    return this.state.channels.find((c) => c.receiverId === receiverId);
  }

  upsertChannel(channel: Channel): void {
    const i = this.state.channels.findIndex((c) => c.id === channel.id);
    if (i >= 0) this.state.channels[i] = channel;
    else this.state.channels.push(channel);
  }

  removeChannel(id: string): void {
    this.state.channels = this.state.channels.filter((c) => c.id !== id);
  }
}

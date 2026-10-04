import type { QueryClient, QueryDevice } from './query-client.js';
import { log } from '../util/log.js';

/**
 * Minimal IS-05 client — enough to drive a *foreign* receiver.
 *
 * This is what makes a copied receiver a real ordering point rather than a decorative
 * IS-04 entry: when someone connects a stream to our proxy, we patch the original
 * receiver in the other registry so the essence actually arrives there.
 */

const TIMEOUT_MS = 8000;
const SR_CTRL = 'urn:x-nmos:control:sr-ctrl/';

export class Is05Error extends Error {}

/** Connection API base of a device, from its IS-04 `controls`. */
export function connectionBaseOf(device: QueryDevice): string | null {
  const controls = (device.controls ?? []).filter((c) => c.type.startsWith(SR_CTRL));
  if (!controls.length) return null;
  // Prefer the highest version advertised.
  const best = controls.sort((a, b) => b.type.localeCompare(a.type))[0]!;
  return best.href.replace(/\/+$/, '');
}

export interface StagedPatch {
  sender_id?: string | null;
  master_enable?: boolean;
  transport_file?: { data: string | null; type: string | null };
  activation?: { mode: 'activate_immediate'; requested_time?: null };
}

export class Is05Client {
  constructor(private readonly query: QueryClient) {}

  private async baseForReceiver(receiverDeviceId: string): Promise<string> {
    const device = await this.query.device(receiverDeviceId);
    const base = connectionBaseOf(device);
    if (!base) {
      throw new Is05Error(`device ${device.label || device.id} advertises no sr-ctrl control — cannot be driven over IS-05`);
    }
    return base;
  }

  /** Connects a foreign receiver to a stream described by `sdp`. */
  async connect(receiverId: string, receiverDeviceId: string, senderId: string | null, sdp: string): Promise<void> {
    await this.patch(receiverId, receiverDeviceId, {
      sender_id: senderId,
      master_enable: true,
      transport_file: { data: sdp, type: 'application/sdp' },
      activation: { mode: 'activate_immediate' },
    });
    log.info({ receiverId, senderId }, 'remote receiver connected');
  }

  /** Disconnects a foreign receiver. */
  async disconnect(receiverId: string, receiverDeviceId: string): Promise<void> {
    await this.patch(receiverId, receiverDeviceId, {
      sender_id: null,
      master_enable: false,
      activation: { mode: 'activate_immediate' },
    });
    log.info({ receiverId }, 'remote receiver disconnected');
  }

  private async patch(receiverId: string, receiverDeviceId: string, body: StagedPatch): Promise<void> {
    const base = await this.baseForReceiver(receiverDeviceId);
    const url = `${base}/single/receivers/${receiverId}/staged`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const err = e as Error;
      const reason =
        err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)
          ? `timeout after ${Math.round(TIMEOUT_MS / 1000)} s`
          : ((err.cause as { code?: string } | undefined)?.code ?? err.message);
      throw new Is05Error(`PATCH ${url}: ${reason}`);
    }
    if (res.status !== 200 && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Is05Error(`PATCH receiver ${receiverId}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
  }
}

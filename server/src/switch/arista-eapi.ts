import type { FabricPlan } from '../types.js';
import type { SwitchDriver, SwitchState } from './driver.js';
import { log } from '../util/log.js';

export interface AristaConfig {
  host: string;
  user: string;
  password: string;
  tls: boolean;
  /** Join method for ingress and egress. The L3 interfaces come per channel from
   *  the domains involved (FabricPlan.ingressInterface / egressInterface). */
  join: 'igmpStatic' | 'pim' | 'none';
  /** Verify the switch's TLS certificate. Usually self-signed in practice. */
  verifyTls?: boolean;
}

/**
 * Command templates.
 *
 * CAUTION — see docs/ARCHITECTURE.md, open point 1: multicast NAT on EOS depends on
 * platform and release. Whether the destination rule belongs on the ingress or (in
 * the twice-NAT case) on the egress interface has to be verified against the target
 * hardware. This is why every switch command lives here and nowhere else.
 *
 * Known and documented: a translation pair's source and destination rule must carry
 * the same `group` number, and for multicast groups EOS installs no reverse path in
 * hardware.
 */
export function buildProgramCommands(plan: FabricPlan, cfg: AristaConfig): string[] {
  const cmds: string[] = ['enable', 'configure'];

  // 1) pull the original stream into the switch
  if (cfg.join === 'igmpStatic') {
    cmds.push(`interface ${plan.ingressInterface}`);
    cmds.push(
      plan.origin.source
        ? `ip igmp static-group ${plan.origin.group} source ${plan.origin.source}`
        : `ip igmp static-group ${plan.origin.group}`,
    );
    cmds.push('exit');
  }

  // 2) translation
  cmds.push(`interface ${plan.ingressInterface}`);
  cmds.push(`ip nat destination static ${plan.origin.group} ${plan.translated.group} group ${plan.natGroupId}`);
  cmds.push('exit');

  if (plan.origin.source && plan.translated.source) {
    cmds.push(`interface ${plan.egressInterface}`);
    cmds.push(`ip nat source static ${plan.origin.source} ${plan.translated.source} group ${plan.natGroupId}`);
    cmds.push('exit');
  }

  // 3) emit the translated group towards the foreign network
  if (cfg.join === 'igmpStatic') {
    cmds.push(`interface ${plan.egressInterface}`);
    cmds.push(`ip igmp static-group ${plan.translated.group}`);
    cmds.push('exit');
  }

  return cmds;
}

export function buildUnprogramCommands(plan: FabricPlan, cfg: AristaConfig): string[] {
  return buildProgramCommands(plan, cfg).map((c) =>
    c === 'enable' || c === 'configure' || c === 'exit' || c.startsWith('interface ') ? c : `no ${c}`,
  );
}

interface EapiResponse {
  jsonrpc: string;
  id: string;
  result?: unknown[];
  error?: { code: number; message: string; data?: unknown[] };
}

export class AristaEapiDriver implements SwitchDriver {
  constructor(readonly id: string, private readonly cfg: AristaConfig) {}

  private async runCmds(cmds: string[], format: 'json' | 'text' = 'json'): Promise<unknown[]> {
    const url = `${this.cfg.tls ? 'https' : 'http'}://${this.cfg.host}/command-api`;
    const auth = Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString('base64');
    const body = {
      jsonrpc: '2.0',
      method: 'runCmds',
      params: { version: 1, cmds, format },
      id: `nmos-federation-${Date.now()}`,
    };

    // TODO: undici agent with rejectUnauthorized: cfg.verifyTls !== false,
    //       timeout and retry with backoff.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`eAPI ${this.cfg.host}: HTTP ${res.status}`);
    const json = (await res.json()) as EapiResponse;
    if (json.error) {
      // EOS aborts on error; the index in the data array shows how far it got.
      const failedAt = Array.isArray(json.error.data) ? json.error.data.length - 1 : -1;
      throw new Error(
        `eAPI ${this.cfg.host}: ${json.error.message}` +
          (failedAt >= 0 ? ` (at command ${failedAt}: ${cmds[failedAt]})` : ''),
      );
    }
    return json.result ?? [];
  }

  async program(plan: FabricPlan, channelId: string): Promise<void> {
    const cmds = buildProgramCommands(plan, this.cfg);
    log.info({ channelId, fabric: plan.fabric, host: this.cfg.host }, 'switch: program');
    await this.runCmds(cmds);
  }

  async unprogram(plan: FabricPlan, channelId: string): Promise<void> {
    const cmds = buildUnprogramCommands(plan, this.cfg);
    log.info({ channelId, fabric: plan.fabric, host: this.cfg.host }, 'switch: unprogram');
    await this.runCmds(cmds);
  }

  async readState(): Promise<SwitchState> {
    // TODO: parse 'show running-config section ip nat' and extract NAT group
    //       numbers so the reconciler can spot orphaned rules.
    const result = await this.runCmds(['enable', 'show running-config section ip nat'], 'text');
    const text = String((result.at(-1) as { output?: string } | undefined)?.output ?? '');
    const lines = text.split('\n').filter((l) => l.trim());
    const natGroupIds = [...text.matchAll(/\bgroup\s+(\d+)/g)].map((m) => Number(m[1]));
    return { natGroupIds: [...new Set(natGroupIds)], lines };
  }

  async probe(): Promise<{ reachable: boolean; version?: string; error?: string }> {
    try {
      const result = await this.runCmds(['show version']);
      const version = (result[0] as { version?: string } | undefined)?.version;
      return { reachable: true, version };
    } catch (e) {
      return { reachable: false, error: (e as Error).message };
    }
  }
}

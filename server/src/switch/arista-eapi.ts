import type { FabricPlan } from '../types.js';
import type { SwitchDriver, SwitchState } from './driver.js';
import { log } from '../util/log.js';

export interface AristaConfig {
  host: string;
  user: string;
  password: string;
  tls: boolean;
  /** Join-Verfahren für Ingress und Egress. Die L3-Interfaces kommen je Channel
   *  aus den beteiligten Domänen (FabricPlan.ingressInterface / egressInterface). */
  join: 'igmpStatic' | 'pim' | 'none';
  /** TLS-Zertifikat des Switches prüfen. In der Praxis meist selbstsigniert. */
  verifyTls?: boolean;
}

/**
 * Kommando-Templates.
 *
 * ACHTUNG — siehe docs/ARCHITECTURE.md, offener Punkt 1: Multicast-NAT ist bei EOS
 * plattform- und releaseabhängig. Ob die Destination-Regel auf das Ingress- oder
 * (im Twice-NAT-Fall) auf das Egress-Interface gehört, muss gegen die Zielhardware
 * verifiziert werden. Alle Switch-Kommandos stehen deshalb nur hier.
 *
 * Bekannt und belegt: Source- und Destination-Regel eines Übersetzungspaares müssen
 * dieselbe `group`-Nummer tragen, und bei Multicast-Gruppen installiert EOS keinen
 * Rückpfad in Hardware.
 */
export function buildProgramCommands(plan: FabricPlan, cfg: AristaConfig): string[] {
  const cmds: string[] = ['enable', 'configure'];

  // 1) Originalstrom in den Switch ziehen
  if (cfg.join === 'igmpStatic') {
    cmds.push(`interface ${plan.ingressInterface}`);
    cmds.push(
      plan.origin.source
        ? `ip igmp static-group ${plan.origin.group} source ${plan.origin.source}`
        : `ip igmp static-group ${plan.origin.group}`,
    );
    cmds.push('exit');
  }

  // 2) Übersetzung
  cmds.push(`interface ${plan.ingressInterface}`);
  cmds.push(`ip nat destination static ${plan.origin.group} ${plan.translated.group} group ${plan.natGroupId}`);
  cmds.push('exit');

  if (plan.origin.source && plan.translated.source) {
    cmds.push(`interface ${plan.egressInterface}`);
    cmds.push(`ip nat source static ${plan.origin.source} ${plan.translated.source} group ${plan.natGroupId}`);
    cmds.push('exit');
  }

  // 3) Übersetzte Gruppe Richtung Fremdnetz ausgeben
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

    // TODO: undici Agent mit rejectUnauthorized: cfg.verifyTls !== false,
    //       Timeout und Retry mit Backoff.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`eAPI ${this.cfg.host}: HTTP ${res.status}`);
    const json = (await res.json()) as EapiResponse;
    if (json.error) {
      // EOS bricht bei Fehler ab; der Index im data-Array zeigt, wie weit es kam.
      const failedAt = Array.isArray(json.error.data) ? json.error.data.length - 1 : -1;
      throw new Error(
        `eAPI ${this.cfg.host}: ${json.error.message}` +
          (failedAt >= 0 ? ` (bei Kommando ${failedAt}: ${cmds[failedAt]})` : ''),
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
    // TODO: 'show running-config section ip nat' auswerten und NAT-Group-Nummern
    //       extrahieren, damit der Reconciler verwaiste Regeln findet.
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

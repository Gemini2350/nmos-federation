import type { FabricPlan } from '../types.js';
import type { SwitchDriver, SwitchState } from './driver.js';
import { buildProgramCommands, buildUnprogramCommands, type AristaConfig } from './arista-eapi.js';
import { log } from '../util/log.js';

/**
 * Logs the commands that would go to a real switch. That makes the whole federation
 * logic playable without hardware — including rollback.
 */
export class MockSwitchDriver implements SwitchDriver {
  readonly applied = new Map<string, string[]>();
  readonly history: { at: string; channelId: string; cmds: string[] }[] = [];

  constructor(readonly id: string, private readonly cfg: AristaConfig) {}

  async program(plan: FabricPlan, channelId: string): Promise<void> {
    const cmds = buildProgramCommands(plan, this.cfg);
    this.applied.set(`${channelId}:${plan.fabric}`, cmds);
    this.history.push({ at: new Date().toISOString(), channelId, cmds });
    log.info({ channelId, fabric: plan.fabric, cmds }, 'mock switch: program');
  }

  async unprogram(plan: FabricPlan, channelId: string): Promise<void> {
    const cmds = buildUnprogramCommands(plan, this.cfg);
    this.applied.delete(`${channelId}:${plan.fabric}`);
    this.history.push({ at: new Date().toISOString(), channelId, cmds });
    log.info({ channelId, fabric: plan.fabric, cmds }, 'mock switch: unprogram');
  }

  async readState(): Promise<SwitchState> {
    const lines = [...this.applied.values()].flat();
    const natGroupIds = [...lines.join('\n').matchAll(/\bgroup\s+(\d+)/g)].map((m) => Number(m[1]));
    return { natGroupIds: [...new Set(natGroupIds)], lines };
  }

  async probe() {
    return { reachable: true, version: 'mock' };
  }
}

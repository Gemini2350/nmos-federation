import type { ChannelPlan, FabricPlan } from '../types.js';

/** Actual state as the reconciler reads it from the switch. */
export interface SwitchState {
  /** NAT group numbers configured on the switch. */
  natGroupIds: number[];
  /** Raw configuration lines, for diagnostics in the GUI. */
  lines: string[];
}

export interface SwitchDriver {
  readonly id: string;
  /** Sets up joins and NAT for a channel. Must be idempotent. */
  program(plan: FabricPlan, channelId: string): Promise<void>;
  /** Removes everything program() created for this channel. */
  unprogram(plan: FabricPlan, channelId: string): Promise<void>;
  /** Reads the actual state for reconciliation. */
  readState(): Promise<SwitchState>;
  /** Reachability + version, for the status display. */
  probe(): Promise<{ reachable: boolean; version?: string; error?: string }>;
}

/** Programs both fabrics and rolls back on partial failure. */
export async function programChannel(
  drivers: Record<string, SwitchDriver>,
  plan: ChannelPlan,
): Promise<void> {
  const done: FabricPlan[] = [];
  try {
    for (const fabricPlan of plan.fabrics) {
      const driver = drivers[fabricPlan.fabric];
      if (!driver) throw new Error(`no switch driver for fabric ${fabricPlan.fabric}`);
      await driver.program(fabricPlan, plan.channelId);
      done.push(fabricPlan);
    }
  } catch (err) {
    // A half-programmed channel is worse than none at all: roll back.
    for (const fabricPlan of done.reverse()) {
      await drivers[fabricPlan.fabric]?.unprogram(fabricPlan, plan.channelId).catch(() => {});
    }
    throw err;
  }
}

export async function unprogramChannel(
  drivers: Record<string, SwitchDriver>,
  plan: ChannelPlan,
): Promise<void> {
  const errors: unknown[] = [];
  for (const fabricPlan of plan.fabrics) {
    await drivers[fabricPlan.fabric]?.unprogram(fabricPlan, plan.channelId).catch((e) => errors.push(e));
  }
  if (errors.length) throw new AggregateError(errors, 'switch teardown incomplete');
}

import type { ChannelPlan, FabricPlan } from '../types.js';

/** Ist-Zustand, wie ihn der Reconciler vom Switch liest. */
export interface SwitchState {
  /** NAT-Group-Nummern, die auf dem Switch konfiguriert sind. */
  natGroupIds: number[];
  /** Rohe Konfigurationszeilen, für Diagnose im GUI. */
  lines: string[];
}

export interface SwitchDriver {
  readonly id: string;
  /** Baut Joins und NAT für einen Channel auf. Muss idempotent sein. */
  program(plan: FabricPlan, channelId: string): Promise<void>;
  /** Räumt alles ab, was program() für diesen Channel angelegt hat. */
  unprogram(plan: FabricPlan, channelId: string): Promise<void>;
  /** Liest den Ist-Zustand für den Soll/Ist-Abgleich. */
  readState(): Promise<SwitchState>;
  /** Erreichbarkeit + Version, für die Statusanzeige. */
  probe(): Promise<{ reachable: boolean; version?: string; error?: string }>;
}

/** Programmiert beide Fabrics und rollt bei Teilfehlern zurück. */
export async function programChannel(
  drivers: Record<string, SwitchDriver>,
  plan: ChannelPlan,
): Promise<void> {
  const done: FabricPlan[] = [];
  try {
    for (const fabricPlan of plan.fabrics) {
      const driver = drivers[fabricPlan.fabric];
      if (!driver) throw new Error(`kein Switch-Treiber für Fabric ${fabricPlan.fabric}`);
      await driver.program(fabricPlan, plan.channelId);
      done.push(fabricPlan);
    }
  } catch (err) {
    // Halb programmierte Channels sind schlimmer als gar keine: zurückrollen.
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
  if (errors.length) throw new AggregateError(errors, 'Abbau auf dem Switch unvollständig');
}

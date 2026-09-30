/**
 * Druckt die EOS-Kommandos, die der Treiber für einen Channel senden würde —
 * zum Gegentesten auf der Hardware, bevor die Software überhaupt läuft.
 *
 *   npm run switch:preview -- --ingress Vlan101 --egress Vlan901
 */
import { buildProgramCommands, buildUnprogramCommands, type AristaConfig } from '../switch/arista-eapi.js';
import type { FabricPlan } from '../types.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args.set(key, process.argv[i + 1] ?? '');
}
const arg = (name: string, fallback: string) => args.get(name) || fallback;

const cfg: AristaConfig = {
  host: arg('host', '10.0.0.11'),
  user: '',
  password: '',
  tls: true,
  join: arg('join', 'igmpStatic') as AristaConfig['join'],
};

const plan: FabricPlan = {
  fabric: arg('fabric', 'red') as FabricPlan['fabric'],
  origin: { group: arg('origin-group', '239.10.1.5'), source: args.get('origin-source') ?? '10.1.1.50' },
  translated: { group: arg('fed-group', '239.200.0.1'), source: args.get('fed-source') ?? '10.9.1.100' },
  natGroupId: Number(arg('group-id', '100')),
  ingressInterface: arg('ingress', 'Vlan101'),
  egressInterface: arg('egress', 'Vlan901'),
  join: cfg.join,
};

console.log(`! Fabric ${plan.fabric}, Switch ${cfg.host}, Join-Modus ${cfg.join}`);
console.log(`! ${plan.origin.group} (${plan.origin.source ?? 'ASM'}) auf ${plan.ingressInterface}`);
console.log(`!   -> ${plan.translated.group} (${plan.translated.source ?? 'unverändert'}) auf ${plan.egressInterface}`);
console.log('\n! ---- Aufbau ----');
for (const cmd of buildProgramCommands(plan, cfg)) console.log(cmd);
console.log('\n! ---- Abbau ----');
for (const cmd of buildUnprogramCommands(plan, cfg)) console.log(cmd);

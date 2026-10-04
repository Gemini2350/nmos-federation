import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelPlan } from './channel.js';
import { DEFAULT_CONFIG, type AppConfig, type DomainConfig } from '../config/schema.js';
import type { Channel } from '../types.js';

const domain = (id: string, kind: 'internal' | 'external', red: string, blue: string): DomainConfig => ({
  id,
  label: id,
  kind,
  iface: { name: 'eth0', address: '10.0.0.1' },
  firstLeg: 'red',
  switchInterface: { red, blue },
  pool: { base: '239.200.0.0', pairs: 4, sourceNat: null },
  enabled: true,
});

const cfg: AppConfig = {
  ...structuredClone(DEFAULT_CONFIG),
  domains: [domain('internal', 'internal', 'Vlan101', 'Vlan102'), domain('partnerA', 'external', 'Vlan901', 'Vlan902')],
};

const channel: Channel = {
  id: 'ch1',
  receiverId: 'rx1',
  deviceId: 'dev1',
  sourceDomain: 'internal',
  targetDomain: 'partnerA',
  state: 'programming',
  originSdp: null,
  originSenderId: null,
  legs: [
    { fabric: 'red', group: '239.10.1.5', source: '10.1.1.50', port: 5004 },
    { fabric: 'blue', group: '239.10.2.5', source: '10.1.2.50', port: 5004 },
  ],
  allocation: {
    domainId: 'partnerA',
    index: 0,
    groups: { blue: '239.200.0.0', red: '239.200.0.1' },
    sources: { red: '10.9.1.100', blue: '10.9.2.100' },
    natGroupId: 100,
  },
  senderSdp: null,
  publishedIn: [],
  error: null,
  updatedAt: '',
};

test('ingress comes from the source domain, egress from the target domain', () => {
  const plan = buildChannelPlan(channel, cfg);
  const red = plan.fabrics.find((f) => f.fabric === 'red')!;
  const blue = plan.fabrics.find((f) => f.fabric === 'blue')!;
  assert.equal(red.ingressInterface, 'Vlan101');
  assert.equal(red.egressInterface, 'Vlan901');
  assert.equal(blue.ingressInterface, 'Vlan102');
  assert.equal(blue.egressInterface, 'Vlan902');
});

test('the reverse direction swaps ingress and egress', () => {
  const back: Channel = { ...channel, sourceDomain: 'partnerA', targetDomain: 'internal' };
  back.allocation = { ...channel.allocation!, domainId: 'internal' };
  const red = buildChannelPlan(back, cfg).fabrics.find((f) => f.fabric === 'red')!;
  assert.equal(red.ingressInterface, 'Vlan901');
  assert.equal(red.egressInterface, 'Vlan101');
});

test('red address is odd, blue is even — the right one per leg', () => {
  const plan = buildChannelPlan(channel, cfg);
  assert.equal(plan.fabrics.find((f) => f.fabric === 'red')!.translated.group, '239.200.0.1');
  assert.equal(plan.fabrics.find((f) => f.fabric === 'blue')!.translated.group, '239.200.0.0');
});

test('both legs share the NAT group number, and no other channel does', () => {
  const plan = buildChannelPlan(channel, cfg);
  assert.deepEqual(plan.fabrics.map((f) => f.natGroupId), [100, 100]);
});

test('a single-leg source programs only its own fabric', () => {
  const single: Channel = { ...channel, legs: [channel.legs[0]!] };
  const plan = buildChannelPlan(single, cfg);
  assert.equal(plan.fabrics.length, 1);
  assert.equal(plan.fabrics[0]!.fabric, 'red');
});

test('a reservation from the wrong domain is rejected', () => {
  const wrong: Channel = { ...channel, allocation: { ...channel.allocation!, domainId: 'internal' } };
  assert.throws(() => buildChannelPlan(wrong, cfg), /reservation came from domain/);
});

test('two legs on the same fabric is a configuration error', () => {
  const dup: Channel = { ...channel, legs: [channel.legs[0]!, { ...channel.legs[1]!, fabric: 'red' }] };
  assert.throws(() => buildChannelPlan(dup, cfg), /two legs on fabric red/);
});

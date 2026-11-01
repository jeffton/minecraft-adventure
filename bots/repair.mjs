import { AsyncLocalStorage } from 'node:async_hooks';
import { safeToResume } from './survival.mjs';

const context = new AsyncLocalStorage();

export function runRepair(token, operation) {
  return context.run(token, operation);
}

export function hasRepairContext(agent) {
  return context.getStore()?.agent === agent;
}

export function repairIsCurrent() {
  const token = context.getStore();
  return !token || token.isCurrent();
}

// Model commands may never interrupt a local survival action or valid program.
// This is checked at dispatch AND at ActionManager entry after command setup.
export function canStartRepairAction(agent) {
  const token = context.getStore();
  return !token || (token.agent === agent && token.isCurrent() && safeToResume(agent.bot));
}

export function canExecuteRepair(agent) {
  return canStartRepairAction(agent) && (!context.getStore() || agent.isIdle());
}

export function patchRepairCommands(source, repairUrl) {
  const oldText = 'export async function executeCommand(agent, message) {';
  if (source.split(oldText).length !== 2) throw new Error('Repair command integration point changed');
  return source.replace(oldText, oldText + '\n    if (!canExecuteRepair(agent)) return;') +
    `\nimport { canExecuteRepair } from ${JSON.stringify(repairUrl)};\n`;
}

export function inventoryContext(bot) {
  return JSON.stringify(bot.inventory.items().map(item => [item.name, item.count])
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function repairOutcomeContext(bot) {
  const position = bot.entity.position;
  return JSON.stringify([inventoryContext(bot), bot.heldItem?.name,
    bot.game.dimension, Math.floor(position.x), Math.floor(position.z)]);
}

export class RepairScheduler {
  constructor({ agent, session, missionId, cancel, now = Date.now }) {
    this.agent = agent;
    this.session = session;
    this.missionId = missionId;
    this.cancel = cancel;
    this.now = now;
    this.generation = 0;
    this.active = null;
    this.lastFailure = null;
    this.lastAttempt = 0;
  }

  invalidate() {
    this.generation++;
    this.active = null;
    this.cancel();
  }

  begin(missionId, failure) {
    if (this.active || !this.agent.isIdle() || !safeToResume(this.agent.bot)) return null;
    if (failure === this.lastFailure && this.now() - this.lastAttempt < 45000) return null;
    const token = {
      agent: this.agent, missionId, session: this.session, generation: ++this.generation,
      isCurrent: () => this.active === token && token.generation === this.generation &&
        token.session === this.session && token.missionId === this.missionId() && this.agent.bot.health > 0,
    };
    this.lastFailure = failure;
    this.lastAttempt = this.now();
    this.active = token;
    return token;
  }

  finish(token) {
    if (this.active !== token) return false;
    this.active = null;
    return true;
  }
}

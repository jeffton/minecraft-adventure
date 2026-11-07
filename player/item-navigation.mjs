// Drops move after spawning: water lifts and carries them away from the mined block.
// Stop pursuing an item removed from the received entity set; inventory observations
// determine whether we collected it, rather than treating disappearance as a gain.
export function itemNavigationGoal(bot, goals, item) {
  return new class extends goals.GoalFollow {
    constructor() { super(item, 0.5); }
    isEnd(node) {
      return !Object.hasOwn(bot.entities, item.id) || super.isEnd(node);
    }
    hasChanged() {
      return !Object.hasOwn(bot.entities, item.id) || super.hasChanged();
    }
  }();
}

function intersectsPanel(from, to, block) {
  // Sweep the player's 0.6 × 1.8 body along the edge, not just its centre.
  return block.shapes.some(shape => {
    let enter = 0;
    let leave = 1;
    for (const [axis, low, high, below, above] of [
      ['x', 0, 3, 0.3, 0.3], ['y', 1, 4, 1.8, 0], ['z', 2, 5, 0.3, 0.3],
    ]) {
      const min = block.position[axis] + shape[low] - below;
      const max = block.position[axis] + shape[high] + above;
      const delta = to[axis] - from[axis];
      if (delta === 0) {
        if (from[axis] <= min || from[axis] >= max) return false;
      } else {
        const a = (min - from[axis]) / delta;
        const b = (max - from[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        leave = Math.min(leave, Math.max(a, b));
        if (enter >= leave) return false;
      }
    }
    return enter < leave;
  });
}

/** Pathfinder treats every door as a solid cube, including its open state. */
export function withDoorPassage(Movements) {
  return class DoorMovements extends Movements {
    getBlock(...args) {
      const block = super.getBlock(...args);
      if (block.name?.endsWith('_door') && block.getProperties().open && !this.blocksToAvoid.has(block.type)) {
        block.safe = true;
        block.physical = false;
        block.height = block.position.y;
      }
      return block;
    }

    getNeighbors(node) {
      return super.getNeighbors(node).filter(next => {
        const from = { x: node.x + 0.5, y: node.y, z: node.z + 0.5 };
        const to = { x: next.x + 0.5, y: next.y, z: next.z + 0.5 };
        for (let x = Math.min(node.x, next.x); x <= Math.max(node.x, next.x); x++) {
          for (let y = Math.min(node.y, next.y); y <= Math.max(node.y, next.y) + 1; y++) {
            for (let z = Math.min(node.z, next.z); z <= Math.max(node.z, next.z); z++) {
              const block = this.getBlock(node, x - node.x, y - node.y, z - node.z);
              if (block.name?.endsWith('_door') && block.getProperties().open && intersectsPanel(from, to, block)) return false;
            }
          }
        }
        return true;
      });
    }
  };
}

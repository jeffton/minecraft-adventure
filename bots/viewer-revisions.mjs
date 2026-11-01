// Self-contained bundle patches: bootstrap embeds these functions via toString.
export function patchViewerRevisionClient(source) {
  const edits = [
    ['this.sectionsOutstanding=new Set', 'this.sectionsOutstanding=new Set,this.sectionRevisions=new Map,this.sectionRevisionCounter=0'],
    ['if("geometry"===t.type){let e=this.sectionMeshs[t.key];', 'if("geometry"===t.type){if(t.revision!==this.sectionRevisions.get(t.key))return;let e=this.sectionMeshs[t.key];'],
    ['"sectionFinished"===t.type&&(this.sectionsOutstanding.delete(t.key)', '"sectionFinished"===t.type&&t.revision===this.sectionRevisions.get(t.key)&&(this.sectionsOutstanding.delete(t.key)'],
    ['resetWorld(){this.active=!1;', 'resetWorld(){this.active=!1;this.sectionRevisions.clear();this.sectionsOutstanding.clear();this.loadedChunks={};'],
    ['this.workers[i].postMessage({type:"dirty",x:t.x,y:t.y,z:t.z,value:e}),this.sectionsOutstanding.add(`${16*Math.floor(t.x/16)},${16*Math.floor(t.y/16)},${16*Math.floor(t.z/16)}`)',
      'const key=`${16*Math.floor(t.x/16)},${16*Math.floor(t.y/16)},${16*Math.floor(t.z/16)}`,revision=++this.sectionRevisionCounter;this.sectionRevisions.set(key,revision);this.sectionsOutstanding.add(key);this.workers[i].postMessage({type:"dirty",x:t.x,y:t.y,z:t.z,value:e,revision})']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream client-revision integration changed');
    source = source.replace(before, after);
  }
  return source;
}

export function patchViewerRevisionWorker(source) {
  const edits = [
    ['function setSectionDirty(e,t=!0){', 'function setSectionDirty(e,t=!0,revision){'],
    ['s=sectionKey(n,a,l);t?', 's=sectionKey(n,a,l);delete dirtySections[s];t?'],
    ['dirtySections[s]=t', 'dirtySections[s]=revision'],
    // Both the missing-chunk and explicit-unload acknowledgements carry revision.
    ['postMessage({type:"sectionFinished",key:s}):(delete dirtySections[s],postMessage({type:"sectionFinished",key:s}))',
      'postMessage({type:"sectionFinished",key:s,revision}):(delete dirtySections[s],postMessage({type:"sectionFinished",key:s,revision}))'],
    ['setSectionDirty(new Vec3(e.x,e.y,e.z),e.value)', 'setSectionDirty(new Vec3(e.x,e.y,e.z),e.value,e.revision)'],
    ['const l=world.getColumn(e,a);if(l&&', 'const revision=dirtySections[t];delete dirtySections[t];const l=world.getColumn(e,a);if(l&&'],
    ['postMessage({type:"geometry",key:t,geometry:l},i)', 'postMessage({type:"geometry",key:t,geometry:l,revision},i)'],
    ['postMessage({type:"sectionFinished",key:t})', 'postMessage({type:"sectionFinished",key:t,revision})'],
    ['world=null,blocksStates=null)},setInterval', 'world=null,blocksStates=null,Object.keys(dirtySections).forEach(key=>delete dirtySections[key]))},setInterval']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream worker-revision integration changed');
    source = source.replace(before, after);
  }
  return source;
}

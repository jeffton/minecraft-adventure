/** Build actor-bound observations together, after asynchronous filesystem evidence resolves. */
export async function readEngineeringPerception(readAudit, buildObservation) {
  const controllerAudit = await readAudit();
  return buildObservation(controllerAudit);
}

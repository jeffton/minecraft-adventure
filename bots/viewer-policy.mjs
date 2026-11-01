export function viewerAllowed(isPublic, existingClasses) {
  const count = existingClasses.filter(value => value === isPublic).length;
  return count < (isPublic ? 8 : 1);
}

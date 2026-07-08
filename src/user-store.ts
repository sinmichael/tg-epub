const userPrefs = new Map<number, string[] | null>();

export function setUserSources(userId: number, sources: string[] | null): void {
  if (sources === null || sources.length === 0) {
    userPrefs.delete(userId);
  } else {
    userPrefs.set(userId, sources);
  }
}

export function getUserSources(userId: number): string[] | null {
  return userPrefs.get(userId) ?? null;
}

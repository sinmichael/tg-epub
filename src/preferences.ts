import db from './db.js';

export interface UserPrefs {
  sources: string[] | null;
  language: string;
  format: string;
}

export function getPrefs(userId: number): UserPrefs {
  const row = db.prepare('SELECT sources, language, format FROM preferences WHERE user_id = ?')
    .get(userId) as { sources: string | null; language: string; format: string } | undefined;

  return {
    sources: row?.sources ? JSON.parse(row.sources) as string[] : null,
    language: row?.language ?? '',
    format: row?.format ?? 'epub',
  };
}

export function setPrefs(userId: number, prefs: Partial<UserPrefs>): void {
  const existing = getPrefs(userId);

  const merged = {
    sources: prefs.sources !== undefined ? prefs.sources : existing.sources,
    language: prefs.language !== undefined ? prefs.language : existing.language,
    format: prefs.format !== undefined ? prefs.format : existing.format,
  };

  db.prepare(`
    INSERT INTO preferences (user_id, sources, language, format)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      sources = excluded.sources,
      language = excluded.language,
      format = excluded.format
  `).run(
    userId,
    merged.sources ? JSON.stringify(merged.sources) : null,
    merged.language,
    merged.format,
  );
}

export function setUserSources(userId: number, sources: string[] | null): void {
  setPrefs(userId, { sources });
}

export function getUserSources(userId: number): string[] | null {
  return getPrefs(userId).sources;
}

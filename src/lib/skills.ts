/** Per-bot enabled skill ids. Mirrors server/store.ts enabledSkillIds.
 * Legacy: empty/missing array + skillId set → [skillId]. */

export function enabledSkillIds(bot: { skillId?: string; enabledSkills?: string[] } | null | undefined): string[] {
  const listed = Array.isArray(bot?.enabledSkills)
    ? bot.enabledSkills.map((id) => String(id).trim()).filter(Boolean)
    : [];
  if (listed.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of listed) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  const legacy = typeof bot?.skillId === "string" ? bot.skillId.trim() : "";
  return legacy ? [legacy] : [];
}

export function toggleSkillId(current: string[], skillId: string): string[] {
  const id = skillId.trim();
  if (!id) return current;
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

/** 章节、章纲“最近一次修改”的修改者和时间显示。 */

export type Stamped = { content_updated_at?: string | null; content_updated_by?: string | null };

const ACTORS: Record<string, [string, string]> = {
  user: ["你", "You"],
  book_agent: ["全自动智能体", "Autonomous agent"],
  assistant: ["协作助手", "Assistant"],
  writing: ["写作生成", "Writing generator"],
};

/** 修改者名称；旧数据没有记录时返回空串。 */
export function actorLabel(actor: string | null | undefined, zh: boolean): string {
  if (!actor) return "";
  const names = ACTORS[actor];
  return names ? names[zh ? 0 : 1] : actor;
}

/** 不是作者本人改的，界面上要提醒。 */
export function byAgent(row: Stamped): boolean {
  return Boolean(row.content_updated_by && row.content_updated_by !== "user");
}

/** 服务端时间可能不带时区（按 UTC 保存），统一按 UTC 解析。 */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 完整时间，例如 2026-10-28 14:05。 */
export function formatFull(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 列表里的短时间：今天只显示时分，其余显示月日时分，跨年加年份。 */
export function formatShort(date: Date, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${date.getMonth() + 1}-${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

/** “14:05 · 全自动智能体”，没有时间时返回空串。 */
export function stampText(row: Stamped, zh: boolean, short = true): string {
  const date = parseServerTime(row.content_updated_at);
  if (!date) return "";
  const who = actorLabel(row.content_updated_by, zh);
  return `${short ? formatShort(date) : formatFull(date)}${who ? ` · ${who}` : ""}`;
}

/** Questions belong to one running request or background job, never to the active editor. */
export interface AgentQuestion {
  id: string;
  novelId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  source: "writing" | "book";
}

export interface PendingAgentQuestion extends AgentQuestion {
  key: string;
  owner: string;
  visible: boolean;
  minimized: boolean;
  submit: (answer: string) => Promise<void>;
}

const EMPTY: readonly PendingAgentQuestion[] = [];
let questions: readonly PendingAgentQuestion[] = EMPTY;
const completed = new Set<string>();
interface QuestionDraft { selected: number[]; note: string }
const drafts = new Map<string, QuestionDraft>();
export const readAgentQuestionDraft = (key: string): QuestionDraft => drafts.get(key) ?? { selected: [], note: "" };
export const saveAgentQuestionDraft = (key: string, draft: QuestionDraft) => { drafts.set(key, draft); };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export const agentQuestionsSnapshot = () => questions;
export const agentQuestionsServerSnapshot = () => EMPTY;
export function subscribeAgentQuestions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function registerAgentQuestion(owner: string, question: AgentQuestion, submit: (answer: string) => Promise<void>, visible = true) {
  const key = `${owner}:${question.id}`;
  if (completed.has(key)) return;
  const old = questions.find((item) => item.key === key);
  const entry: PendingAgentQuestion = { ...question, owner, key, submit, visible, minimized: old?.minimized ?? false };
  questions = old ? questions.map((item) => item.key === key ? entry : item) : [...questions, entry];
  emit();
}

export function completeAgentQuestion(owner: string, id: string) {
  const key = `${owner}:${id}`;
  completed.add(key);
  drafts.delete(key);
  questions = questions.filter((item) => item.key !== key);
  emit();
}

export function clearAgentQuestionOwner(owner: string) {
  const next = questions.filter((item) => item.owner !== owner);
  for (const key of completed) if (key.startsWith(`${owner}:`)) completed.delete(key);
  for (const key of drafts.keys()) if (key.startsWith(`${owner}:`)) drafts.delete(key);
  if (next.length === questions.length) return;
  questions = next;
  emit();
}

/** Closing only hides a question. It never supplies an answer or resumes a task. */
export function minimizeAgentQuestion(key: string) {
  questions = questions.map((item) => item.key === key ? { ...item, minimized: true } : item);
  emit();
}

export function reopenAgentQuestion(owner: string, id: string) {
  const key = `${owner}:${id}`;
  const item = questions.find((row) => row.key === key);
  if (!item) return;
  questions = [{ ...item, minimized: false }, ...questions.filter((row) => row.key !== key)];
  emit();
}

/** Preserve option order; custom text can answer questions that have no suitable option. */
export function questionAnswer(options: readonly string[], selected: readonly number[], note: string): string {
  const picked = options.filter((_, index) => selected.includes(index));
  return [...picked, ...(note.trim() ? [note.trim()] : [])].join("\n");
}

/** Reject a question addressed to another book instead of sending an answer across books. */
export function parseAgentQuestion(data: Record<string, unknown>, novelId: string): AgentQuestion | null {
  if (!novelId || typeof data.id !== "string" || !data.id || typeof data.question !== "string" || !data.question.trim()
    || (data.novel_id !== undefined && data.novel_id !== novelId)) return null;
  return { id: data.id, novelId, question: data.question,
    options: Array.isArray(data.options) ? [...new Set(data.options.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))].slice(0, 12) : [],
    multiSelect: data.multi_select === true, source: "writing" };
}

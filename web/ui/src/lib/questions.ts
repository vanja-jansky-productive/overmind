// AskUserQuestion prompts in the chat — pure, unit-tested in questions.test.ts.
import type { Message, Question, QuestionAnswer } from '@/api/types'

export const isQuestion = (m: Message | null | undefined): boolean => m?.kind === 'question' && Array.isArray(m.questions)
export const isOpenQuestion = (m: Message | null | undefined): boolean => isQuestion(m) && !m!.answers && !m!.declined

/** The prompt Claude is waiting on: the last question message, while it has no outcome. */
export function pendingQuestion(messages: Message[] | null | undefined): Message | null {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isQuestion(list[i])) return isOpenQuestion(list[i]) ? list[i] : null
  }
  return null
}

/** What the card holds per question while it is being answered. */
export interface QuestionDraft {
  options: number[]
  text: string
}

export const emptyDrafts = (questions: Question[]): QuestionDraft[] => questions.map(() => ({ options: [], text: '' }))

/** Tap an option: single-select replaces (and clears the typed text), multi-select toggles. */
export function toggleOption(q: Question, d: QuestionDraft, index: number): QuestionDraft {
  if (!q.multiSelect) return { options: [index], text: '' }
  const options = d.options.includes(index) ? d.options.filter((n) => n !== index) : [...d.options, index].sort((a, b) => a - b)
  return { ...d, options }
}

/** Type in "Other": single-select drops the picked option (one answer per question). */
export function typeOther(q: Question, d: QuestionDraft, text: string): QuestionDraft {
  const line = text.replace(/[\r\n]+/g, ' ')
  return q.multiSelect ? { ...d, text: line } : { options: line.trim() ? [] : d.options, text: line }
}

export const isAnswered = (d: QuestionDraft): boolean => d.options.length > 0 || d.text.trim().length > 0

export function toAnswers(drafts: QuestionDraft[]): QuestionAnswer[] {
  return drafts.map((d) => (d.text.trim() ? { options: d.options, text: d.text.trim() } : { options: d.options }))
}

/** "Merge (Recommended)" → the label without the "(Recommended)" tag, and whether it had it. */
export function splitRecommended(label: string): { label: string; recommended: boolean } {
  const m = label.match(/^(.*?)\s*\(recommended\)\s*$/i)
  return m ? { label: m[1], recommended: true } : { label, recommended: false }
}

/** The options as shown: primary picks first, `secondary` ones (lasting side effects) apart — each with its menu index. */
export function splitOptions(q: Question): { primary: number[]; secondary: number[] } {
  const primary: number[] = []
  const secondary: number[] = []
  q.options.forEach((o, i) => (o.secondary ? secondary : primary).push(i))
  return { primary, secondary }
}

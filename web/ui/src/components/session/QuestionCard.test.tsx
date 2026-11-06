import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import type { Message } from '@/api/types'
import { emptyDrafts, splitOptions, toAnswers, toggleOption } from '@/lib/questions'

import { QuestionCard } from './QuestionCard'

// Codex's approval menu as /messages serves it (web/lib/questions.mjs parseCodexScreenPrompt).
const approval: Message = {
  role: 'assistant',
  kind: 'question',
  id: 'screen:0123456789ab',
  text: '',
  questions: [
    {
      header: 'Approval',
      question: 'Would you like to run the following command?\n$ printf hi > hello.txt\nReason: Allow creating hello.txt?',
      multiSelect: false,
      noOther: true,
      options: [
        { label: 'Yes, proceed', description: '' },
        {
          label: "Yes, and don't ask again for commands that start with `printf hi > hello.txt`",
          description: 'Adds a permanent allow rule for commands starting with `printf hi > hello.txt` — for every Codex session on this host',
          secondary: true,
        },
        { label: 'No, and tell Codex what to do differently', description: '' },
      ],
    },
  ],
}

const actions = { answer: async () => {}, dismiss: async () => {} }

test('a Codex approval: options 1 and 3 as buttons, option 2 apart and quieter with its consequence, no free text', () => {
  const html = renderToStaticMarkup(<QuestionCard m={approval} actions={actions} />)
  const at = (s: string) => html.indexOf(s)
  expect(at('Yes, proceed')).toBeGreaterThan(-1)
  expect(at('Yes, proceed')).toBeLessThan(at('No, and tell Codex'))
  expect(at('No, and tell Codex')).toBeLessThan(at('Yes, and don&#x27;t ask again'))
  expect(html.match(/data-secondary="true"/g)?.length).toBe(1)
  expect(html).toContain('Adds a permanent allow rule')
  expect(html).not.toContain('Something else')
  expect(html.match(/role="radio"/g)?.length).toBe(3)
})

test('picking the secondary option answers with its menu index', () => {
  const q = approval.questions![0]
  expect(splitOptions(q)).toEqual({ primary: [0, 2], secondary: [1] })
  const [d] = emptyDrafts([q])
  expect(toAnswers([toggleOption(q, d, 1)])).toEqual([{ options: [1] }])
  expect(toAnswers([toggleOption(q, d, 2)])).toEqual([{ options: [2] }])
})

test("a Codex patch approval: its files and the diff preview, + and − lines marked, in the open card and the record", () => {
  const patch: Message = {
    ...approval,
    questions: [
      {
        header: 'Edit approval',
        question: 'Would you like to make the following edits?\nFiles:\n  a.txt\n  new.txt',
        preview: '*** Update File: a.txt\n@@\n alpha\n-old line\n+patched by mock 1',
        multiSelect: false,
        noOther: true,
        options: [
          { label: 'Yes, proceed', description: '' },
          { label: "Yes, and don't ask again for these files", description: 'Approves edits to these files for the rest of this session', secondary: true },
          { label: 'No, and tell Codex what to do differently', description: '' },
        ],
      },
    ],
  }
  for (const html of [
    renderToStaticMarkup(<QuestionCard m={patch} actions={actions} />),
    renderToStaticMarkup(<QuestionCard m={{ ...patch, answers: ['Yes, proceed'] }} />),
  ]) {
    expect(html).toContain('aria-label="Diff preview"')
    expect(html).toMatch(/data-diff="add"[^>]*>\+patched by mock 1</)
    expect(html).toMatch(/data-diff="del"[^>]*>-old line</)
    expect(html).toMatch(/data-diff="file"[^>]*>\*\*\* Update File: a\.txt</)
  }
  expect(renderToStaticMarkup(<QuestionCard m={approval} actions={actions} />)).not.toContain('Diff preview')
})

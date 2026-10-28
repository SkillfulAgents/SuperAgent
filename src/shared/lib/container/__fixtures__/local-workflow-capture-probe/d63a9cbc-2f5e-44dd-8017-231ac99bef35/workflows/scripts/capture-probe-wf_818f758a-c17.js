
export const meta = {
  name: 'capture-probe',
  description: 'Minimal probe to exercise workflow machinery',
  phases: [
    { title: 'Scan', detail: '2 parallel agents returning single words' },
    { title: 'Summarize', detail: '1 agent concatenating results' },
  ],
}

phase('Scan')
const [a, b] = await parallel([
  () => agent('Return ONLY the single word: alpha', { label: 'word-alpha', phase: 'Scan' }),
  () => agent('Return ONLY the single word: beta', { label: 'word-beta', phase: 'Scan' }),
])

phase('Summarize')
const result = await agent(
  `Concatenate these two words with a hyphen and return ONLY that: "${a}" and "${b}". Expected output: alpha-beta`,
  { label: 'concat', phase: 'Summarize' }
)

return { a, b, result }

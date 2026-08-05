export const meta = { name: 'capture-probe', description: 'fixture capture probe', phases: [{ title: 'Run' }] }
phase('Run')
const a = await agent('Reply with exactly: wf-alpha')
const word1 = "alpha", word2 = "beta"
const b = await agent(`Concatenate these two words with a dash and reply with only the result: ${word1} ${word2}`)
return { a, b }
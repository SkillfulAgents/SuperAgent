import { describe, it, expect } from 'vitest'
import { displayNameForPath, stripUploadPrefix } from './upload-display-name'

describe('stripUploadPrefix', () => {
  it('removes a 13-digit epoch prefix and its dash', () => {
    expect(stripUploadPrefix('1788459888315-report.pdf')).toBe('report.pdf')
  })

  it('leaves ordinary names, shorter numbers, and no-dash names alone', () => {
    expect(stripUploadPrefix('report.pdf')).toBe('report.pdf')
    expect(stripUploadPrefix('2024-report.pdf')).toBe('2024-report.pdf')
    expect(stripUploadPrefix('1788459888315report.pdf')).toBe('1788459888315report.pdf')
  })
})

describe('displayNameForPath', () => {
  it('takes the basename and strips the prefix, tolerating trailing slashes', () => {
    expect(displayNameForPath('/workspace/uploads/1788459888315-sample.obj')).toBe('sample.obj')
    expect(displayNameForPath('/workspace/uploads/1788459888315-my-project/')).toBe('my-project')
    expect(displayNameForPath('/workspace/output/report.md')).toBe('report.md')
    expect(displayNameForPath('/')).toBe('/')
  })
})

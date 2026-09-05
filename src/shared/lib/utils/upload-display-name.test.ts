import { describe, it, expect } from 'vitest'
import { displayNameForPath, stripUploadPrefix } from './upload-display-name'

describe('stripUploadPrefix', () => {
  it('removes the suffix form (timestamp before the extension) and the legacy prefix form', () => {
    expect(stripUploadPrefix('report-1788459888315.pdf')).toBe('report.pdf')
    expect(stripUploadPrefix('archive.tar-1788459888315.gz')).toBe('archive.tar.gz')
    expect(stripUploadPrefix('README-1788459888315')).toBe('README')
    expect(stripUploadPrefix('1788459888315-report.pdf')).toBe('report.pdf')
  })

  it('leaves ordinary names, shorter numbers, and mid-name numbers alone', () => {
    expect(stripUploadPrefix('report.pdf')).toBe('report.pdf')
    expect(stripUploadPrefix('report-2024.pdf')).toBe('report-2024.pdf')
    expect(stripUploadPrefix('2024-report.pdf')).toBe('2024-report.pdf')
    expect(stripUploadPrefix('a-1788459888315-b.pdf')).toBe('a-1788459888315-b.pdf')
  })
})

describe('displayNameForPath', () => {
  it('takes the basename and strips the timestamp, tolerating trailing slashes', () => {
    expect(displayNameForPath('/workspace/uploads/sample-1788459888315.obj')).toBe('sample.obj')
    expect(displayNameForPath('/workspace/uploads/1788459888315-sample.obj')).toBe('sample.obj')
    expect(displayNameForPath('/workspace/uploads/1788459888315-my-project/')).toBe('my-project')
    expect(displayNameForPath('/workspace/output/report.md')).toBe('report.md')
    expect(displayNameForPath('/')).toBe('/')
  })
})

import { describe, it, expect } from 'vitest'
import { deploymentRoleFor } from './platform-role'

describe('deploymentRoleFor', () => {
  it('makes platform owners and admins deployment admins', () => {
    expect(deploymentRoleFor('owner')).toBe('admin')
    expect(deploymentRoleFor('admin')).toBe('admin')
  })

  it('makes every other value a deployment user', () => {
    expect(deploymentRoleFor('member')).toBe('user')
    expect(deploymentRoleFor('superadmin')).toBe('user')
    expect(deploymentRoleFor(undefined)).toBe('user')
  })
})

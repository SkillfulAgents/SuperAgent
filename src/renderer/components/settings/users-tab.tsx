import { useState, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { authClient } from '@renderer/lib/auth-client'
import { useUser } from '@renderer/context/user-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  Search,
  Ban,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  UserPlus,
  UserCheck,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { InviteUserDialog } from './invite-user-dialog'

interface AdminUser {
  id: string
  name: string
  email: string
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  mustChangePassword?: boolean | null
  createdAt: Date
}

export function UsersTab() {
  const { user: currentUser } = useUser()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const [page, setPage] = useState(0)
  const [sortBy, setSortBy] = useState<'createdAt' | 'name'>('createdAt')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [inviteOpen, setInviteOpen] = useState(false)

  const [confirmAction, setConfirmAction] = useState<{
    type: 'delete' | 'ban'
    user: AdminUser
  } | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const PAGE_SIZE = 10

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users', debouncedSearch, page, sortBy, sortDirection],
    queryFn: async () => {
      const params: Record<string, string> = {
        sortBy,
        sortDirection,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      }
      if (debouncedSearch.trim()) {
        params.searchValue = debouncedSearch.trim()
        params.searchField = 'email'
        params.searchOperator = 'contains'
      }
      const res = await authClient.admin.listUsers({ query: params })
      return res.data as { users: AdminUser[]; total: number } | undefined
    },
  })

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  const toggleSort = (column: 'createdAt' | 'name') => {
    if (sortBy === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(column)
      setSortDirection(column === 'name' ? 'asc' : 'desc')
    }
    setPage(0)
  }

  const SortIcon = ({ column }: { column: 'createdAt' | 'name' }) => {
    if (sortBy !== column) return <ChevronsUpDown className="h-3 w-3 ml-0.5" />
    return sortDirection === 'asc' ? (
      <ChevronUp className="h-3 w-3 ml-0.5" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-0.5" />
    )
  }

  const users = data?.users ?? []
  const adminCount = users.filter((u) => u.role === 'admin').length

  const invalidateUsers = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['admin-users'] })
  }, [queryClient])

  const handleRoleChange = async (userId: string, newRole: 'admin' | 'user') => {
    setActionLoading(userId)
    try {
      await authClient.admin.setRole({ userId, role: newRole })
      invalidateUsers()
    } catch (err) {
      console.error('Failed to change role:', err)
    } finally {
      setActionLoading(null)
    }
  }

  const handleBan = async (user: AdminUser) => {
    setActionLoading(user.id)
    setConfirmAction(null)
    try {
      await authClient.admin.banUser({ userId: user.id })
      invalidateUsers()
    } catch (err) {
      console.error('Failed to ban user:', err)
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnban = async (userId: string) => {
    setActionLoading(userId)
    try {
      await authClient.admin.unbanUser({ userId })
      invalidateUsers()
    } catch (err) {
      console.error('Failed to unban user:', err)
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async (user: AdminUser) => {
    setActionLoading(user.id)
    setConfirmAction(null)
    try {
      await authClient.admin.removeUser({ userId: user.id })
      invalidateUsers()
    } catch (err) {
      console.error('Failed to delete user:', err)
    } finally {
      setActionLoading(null)
    }
  }

  if (error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load users. Make sure you have admin access.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with Invite button */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Users</span>
        <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4 mr-1.5" />
          Invite
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-8"
          data-testid="users-search"
        />
      </div>

      {/* User list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading users...
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          {search ? 'No users match your search.' : 'No users found.'}
        </div>
      ) : (
        <div className="space-y-1">
          {/* Header */}
          <div className="grid grid-cols-[1fr_1fr_100px_80px_80px] gap-2 px-2 py-1 text-xs font-medium text-muted-foreground">
            <button
              className="flex items-center hover:text-foreground transition-colors cursor-pointer"
              onClick={() => toggleSort('name')}
            >
              Name
              <SortIcon column="name" />
            </button>
            <span>Email</span>
            <span>Role</span>
            <button
              className="flex items-center hover:text-foreground transition-colors cursor-pointer"
              onClick={() => toggleSort('createdAt')}
            >
              Joined
              <SortIcon column="createdAt" />
            </button>
            <span className="text-right">Actions</span>
          </div>

          {/* Rows */}
          {users.map((user) => {
            const isSelf = user.id === currentUser?.id
            const isOnlyAdmin = user.role === 'admin' && adminCount <= 1
            const isRowLoading = actionLoading === user.id
            const isPendingApproval = user.banned && user.banReason === 'Pending admin approval'

            return (
              <div
                key={user.id}
                data-testid={`user-row-${user.email}`}
                className={cn(
                  'grid grid-cols-[1fr_1fr_100px_80px_80px] gap-2 items-center px-2 py-1.5 rounded text-sm',
                  user.banned && 'opacity-60',
                  isRowLoading && 'opacity-50 pointer-events-none'
                )}
              >
                {/* Name */}
                <div className="truncate flex items-center gap-1.5">
                  <span className="truncate">{user.name}</span>
                  {isSelf && (
                    <span className="text-[10px] text-muted-foreground shrink-0">(you)</span>
                  )}
                  {isPendingApproval ? (
                    <span className="text-[10px] text-amber-500 shrink-0">Pending Approval</span>
                  ) : user.banned && (
                    <span className="text-[10px] text-destructive shrink-0">Banned</span>
                  )}
                  {user.mustChangePassword && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="shrink-0 h-2 w-2 rounded-full bg-amber-500" />
                      </TooltipTrigger>
                      <TooltipContent>Must change password on next login</TooltipContent>
                    </Tooltip>
                  )}
                </div>

                {/* Email */}
                <span className="truncate text-muted-foreground">
                  {debouncedSearch.trim() ? (() => {
                    const idx = user.email.toLowerCase().indexOf(debouncedSearch.trim().toLowerCase())
                    if (idx === -1) return user.email
                    const before = user.email.slice(0, idx)
                    const match = user.email.slice(idx, idx + debouncedSearch.trim().length)
                    const after = user.email.slice(idx + debouncedSearch.trim().length)
                    return <>{before}<mark className="bg-yellow-200 dark:bg-yellow-800 rounded-sm">{match}</mark>{after}</>
                  })() : user.email}
                </span>

                {/* Role */}
                <div>
                  {isSelf || isOnlyAdmin ? (
                    <span className="inline-flex items-center gap-1 text-xs">
                      {user.role === 'admin' ? (
                        <ShieldCheck className="h-3 w-3 text-amber-500" />
                      ) : (
                        <ShieldAlert className="h-3 w-3 text-muted-foreground" />
                      )}
                      {user.role || 'user'}
                    </span>
                  ) : (
                    <Select
                      value={user.role || 'user'}
                      onValueChange={(value) => handleRoleChange(user.id, value as 'admin' | 'user')}
                    >
                      <SelectTrigger className="h-6 text-xs w-[85px]" data-testid={`user-role-${user.email}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="user">user</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* Joined */}
                <span className="text-xs text-muted-foreground">
                  {new Date(user.createdAt).toLocaleDateString()}
                </span>

                {/* Actions */}
                <div className="flex items-center justify-end gap-1">
                  {!isSelf && (
                    <>
                      {isPendingApproval ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => handleUnban(user.id)}
                          title="Approve user"
                          data-testid={`user-approve-${user.email}`}
                        >
                          <UserCheck className="h-3.5 w-3.5 text-green-600" />
                        </Button>
                      ) : user.banned ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => handleUnban(user.id)}
                          title="Unban user"
                          data-testid={`user-unban-${user.email}`}
                        >
                          <Ban className="h-3.5 w-3.5 text-green-600" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => setConfirmAction({ type: 'ban', user })}
                          title="Ban user"
                          data-testid={`user-ban-${user.email}`}
                        >
                          <Ban className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => setConfirmAction({ type: 'delete', user })}
                        title="Delete user"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Total count & pagination */}
      {data && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {data.total} user{data.total !== 1 ? 's' : ''} total
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Invite Dialog */}
      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={invalidateUsers}
      />

      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === 'delete' ? 'Delete User' : 'Ban User'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === 'delete' ? (
                <>
                  Are you sure you want to permanently delete{' '}
                  <strong>{confirmAction.user.name}</strong> ({confirmAction.user.email})?
                  This will remove their account and all associated sessions. This action cannot be
                  undone.
                </>
              ) : (
                <>
                  Are you sure you want to ban{' '}
                  <strong>{confirmAction?.user.name}</strong> ({confirmAction?.user.email})?
                  They will be unable to log in until unbanned.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirmAction) return
                if (confirmAction.type === 'delete') {
                  handleDelete(confirmAction.user)
                } else {
                  handleBan(confirmAction.user)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirmAction?.type === 'delete' ? 'Delete' : 'Ban'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

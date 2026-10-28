const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export function formatUsd(amount: number): string { return usd.format(amount) }
export function formatCents(cents: number): string { return formatUsd(cents / 100) }

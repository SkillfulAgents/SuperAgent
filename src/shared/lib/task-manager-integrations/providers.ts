import { githubProvider } from './github/provider'
import { linearProvider } from './linear/provider'

export const taskManagerProviders = [linearProvider, githubProvider]

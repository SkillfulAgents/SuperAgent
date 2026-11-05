/**
 * AppState: keyed state and live events shared by every process that serves
 * one tenant. docs/app-state.md has the contract and how to add a namespace.
 */
export type * from './contract'
export { appState, closeAppState, initializeAppState, initializeLocalAppState, isAppStateInitialized } from './app-state'
export { defineNamespace, defineTopic, digestKeyPart } from './definitions'
export { createLocalAppState, LocalAppStateBackend, LOCAL_APP_STATE_SCOPE } from './local-app-state'
export { reduceRecord, type RecordChange, type ReduceRecordOptions } from './reduce-record'

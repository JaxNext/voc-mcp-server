// Worker entry module. Exports only the default handler: workerd validates the
// entry module's named exports as entrypoints (each must be a function or an
// ExportedHandler), so the provider's constants and helpers live in
// ./provider instead of being exported alongside it.
export { default } from './provider'

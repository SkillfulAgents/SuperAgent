declare module '@analytics/amplitude' {
  function amplitudePlugin(config: { apiKey: string; pluginName?: string }): any
  export default amplitudePlugin
}

declare module '@analytics/google-analytics' {
  function googleAnalyticsPlugin(config: { measurementIds: string[] }): any
  export default googleAnalyticsPlugin
}

declare module '@analytics/mixpanel' {
  function mixpanelPlugin(config: { token: string }): any
  export default mixpanelPlugin
}

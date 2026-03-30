/**
 * Telemetry runtime configuration.
 */
export interface TelemetryConfig {
  /**
   * Enables telemetry collection.
   * Default is false for OSS/self-host privacy-first behavior.
   */
  enabled: boolean
  /** Endpoint URL for remote telemetry ingestion. */
  endpointUrl: string
  /** Maximum number of events per flush batch. */
  batchSize: number
}

/**
 * Default telemetry configuration for OSS usage.
 */
export const defaultTelemetryConfig: TelemetryConfig = {
  enabled: false,
  endpointUrl: '',
  batchSize: 100
}

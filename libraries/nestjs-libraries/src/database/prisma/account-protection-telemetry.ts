import { SpanStatusCode } from '@opentelemetry/api';

let actionCounter: any;
let eventCounter: any;
let telemetryTracer: any;

let meterProvider: any;
let traceProvider: any;
let metricReader: any;
let startPromise: Promise<void> | undefined;
let memoryMetricExporter: any;
let memorySpanExporter: any;

export function accountProtectionTelemetryAttributes(provider: string, action: string, outcome: string) {
  return { provider, action, outcome };
}

export function recordAccountProtectionEvent(provider: string, action: string, outcome: string) {
  if (process.env.OTEL_ENABLED !== 'true' || !meterProvider || !traceProvider) return;
  if (!actionCounter || !eventCounter || !telemetryTracer) {
    const meter = meterProvider.getMeter('sns-studio-account-protection', '1.0.0');
    actionCounter = meter.createCounter('sns_studio.account_protection.actions');
    eventCounter = meter.createCounter('sns_studio.account_protection.events');
    telemetryTracer = traceProvider.getTracer('sns-studio-account-protection', '1.0.0');
  }
  const attributes = accountProtectionTelemetryAttributes(provider, action, outcome);
  actionCounter.add(1, attributes);
  eventCounter.add(1, { ...attributes, 'event.name': outcome });
  const span = telemetryTracer.startSpan('sns_studio.account_protection.event', { attributes: { ...attributes, 'event.name': outcome } });
  span.setStatus({ code: outcome === 'provider_failure' || outcome === 'auth_failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}

export async function startAccountProtectionTelemetry() {
  if (process.env.OTEL_ENABLED !== 'true' || meterProvider) return;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    try {
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '');
      const { MeterProvider, PeriodicExportingMetricReader, InMemoryMetricExporter } = require('@opentelemetry/sdk-metrics');
      const { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
      const metricExporter = endpoint
        ? new (require('@opentelemetry/exporter-metrics-otlp-http').OTLPMetricExporter)({ url: `${endpoint}/v1/metrics` })
        : process.env.NODE_ENV === 'test' ? (memoryMetricExporter = new InMemoryMetricExporter()) : undefined;
      const spanExporter = endpoint
        ? new (require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter)({ url: `${endpoint}/v1/traces` })
        : process.env.NODE_ENV === 'test' ? (memorySpanExporter = new InMemorySpanExporter()) : undefined;
      if (!metricExporter || !spanExporter) {
        console.warn('Account Protection telemetry enabled without an OTLP endpoint; no exporter was started.');
        return;
      }
      metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 5000 });
      meterProvider = new MeterProvider({ readers: [metricReader] });
      traceProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
      const meter = meterProvider.getMeter('sns-studio-account-protection', '1.0.0');
      actionCounter = meter.createCounter('sns_studio.account_protection.actions');
      eventCounter = meter.createCounter('sns_studio.account_protection.events');
      telemetryTracer = traceProvider.getTracer('sns-studio-account-protection', '1.0.0');
    } catch {
      meterProvider = undefined;
      traceProvider = undefined;
      console.warn('Account Protection telemetry exporter could not be started.');
    }
  })();
  return startPromise;
}

export async function flushAccountProtectionTelemetry() {
  if (meterProvider) await meterProvider.forceFlush();
  if (traceProvider) await traceProvider.forceFlush();
  return {
    metrics: memoryMetricExporter?.getMetrics?.() ?? [],
    spans: memorySpanExporter?.getFinishedSpans?.() ?? [],
  };
}

export async function stopAccountProtectionTelemetry() {
  if (meterProvider) await meterProvider.shutdown();
  if (traceProvider) await traceProvider.shutdown();
  meterProvider = undefined;
  metricReader = undefined;
  startPromise = undefined;
  memoryMetricExporter = undefined;
  memorySpanExporter = undefined;
  actionCounter = undefined;
  eventCounter = undefined;
  telemetryTracer = undefined;
}

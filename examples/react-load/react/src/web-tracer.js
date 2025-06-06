import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BaseOpenTelemetryComponent } from '@opentelemetry/plugin-react-load';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { CollectorTraceExporter } from '@opentelemetry/exporter-collector';
import { diag, DiagConsoleLogger } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export default (serviceName) => {
  const exporter = new CollectorTraceExporter({
    url: 'http://localhost:55678/v1/trace',
  });

  const provider = new WebTracerProvider({
    resource: new Resource({
        [ATTR_SERVICE_NAME]: "react-load-example"
    }),
    spanProcessors: [
      new SimpleSpanProcessor(new ConsoleSpanExporter()),
      new SimpleSpanProcessor(exporter),
    ],
  });

  provider.register({
    contextManager: new ZoneContextManager(),
  });

  const tracer = provider.getTracer(serviceName);

  BaseOpenTelemetryComponent.setTracer(serviceName)
  diag.setLogger(new DiagConsoleLogger());

  return tracer;
}

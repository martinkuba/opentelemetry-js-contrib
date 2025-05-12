const {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} = require('@opentelemetry/sdk-logs');
import { events } from '@opentelemetry/api-events';
import { EventLoggerProvider } from '@opentelemetry/sdk-events';
import { WebExceptionInstrumentation } from '@opentelemetry/instrumentation-web-exception';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

// Set up the logger provider and event logger
const loggerProvider = new LoggerProvider();
loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())); 

const eventLoggerProvider = new EventLoggerProvider(loggerProvider);
events.setGlobalEventLoggerProvider(eventLoggerProvider);

// Register the instrumentation
registerInstrumentations({
  instrumentations: [
    new WebExceptionInstrumentation({
      // Optional: customize attributes added to error events
      applyCustomAttributes: (error) => ({
        'app.error.severity': error.name === 'ValidationError' ? 'warning' : 'error',
        'custom.correlation.id': window.correlationId,
      }),
    }),
  ],
});


// window.addEventListener('load', prepareClickEvents);

function prepareClickEvents() {
  const btn1 = document.getElementById('btnGenerateError');
  btn1.addEventListener('click', function() {
    setTimeout(generateUnhandledException, 100);
  });

  const btn2 = document.getElementById('btnGenerateUnhandledRejection');
  btn2.addEventListener('click', function() {
    setTimeout(generateUnhandledRejection, 100);
  });
}

function generateUnhandledRejection() {
  Promise.reject(new Error('Test unhandled rejection'));
}

function generateUnhandledException() {
  throw new Error('Test unhandled exception');
}

// setTimeout(generateUnhandledRejection, 100);

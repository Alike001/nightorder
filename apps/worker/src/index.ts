import { startNightOrderTelegram } from './live-telegram.js';

// Avoid launching a polling worker when Vitest imports this module.
// Set NIGHTORDER_START=1 to run the actual long-lived bot process.
if (process.env.NIGHTORDER_START === '1') {
  void startNightOrderTelegram().catch(() => {
    // Deliberately avoid logging raw errors from libraries which may embed secrets.
    console.error(
      'NIGHTORDER_WORKER_START_FAILED: check environment and local configuration',
    );
    process.exitCode = 1;
  });
}

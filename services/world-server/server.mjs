// Entry point: validate configuration, start the service, exit cleanly.
//
// A misconfigured service refuses to start rather than running without identity
// verification or without a ticket secret. `WORLD_HOST` defaults to loopback, so
// exposing the socket to a network is an explicit operator decision.
import { loadConfig } from './lib/config.mjs';
import { startWorldServer } from './app.mjs';

const config = loadConfig();

if (config.problems.length) {
  for (const problem of config.problems) console.error(`world-server: ${problem}`);
  process.exit(1);
}

const log = (event, meta = {}) => {
  // Structured, one line per event, and never a coordinate or a token: the log is
  // not a second copy of presence.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...meta }));
};

let running;
try {
  running = await startWorldServer({ config, log });
  log('world_ready', {
    port: config.port,
    host: config.host,
    exposed: config.exposed,
    ticketTtlMs: config.ticketTtlMs,
  });
} catch (error) {
  log('world_start_failed', { message: error && error.message ? error.message : String(error) });
  process.exit(1);
}

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  log('world_stopping', { signal });
  try {
    await running.close();
    log('world_stopped');
    process.exit(0);
  } catch (error) {
    log('world_stop_failed', { message: error && error.message ? error.message : String(error) });
    process.exit(1);
  }
};

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

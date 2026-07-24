const assert = require('node:assert/strict');
const { app, powerSaveBlocker } = require('electron');

const MARKER = 'PHRIO_ELECTRON_POWER_SAVE_BLOCKER';
const TIMEOUT_MILLISECONDS = 10_000;

async function verify() {
  await app.whenReady();
  let blockerId = null;
  try {
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    assert.equal(Number.isSafeInteger(blockerId), true);
    assert.equal(powerSaveBlocker.isStarted(blockerId), true);
    assert.equal(powerSaveBlocker.stop(blockerId), true);
    assert.equal(powerSaveBlocker.isStarted(blockerId), false);

    process.stdout.write(`${MARKER} ${JSON.stringify({
      electronVersion: process.versions.electron,
      blockerType: 'prevent-app-suspension',
      acquired: true,
      released: true,
      leaked: false,
    })}\n`);
    blockerId = null;
  } finally {
    if (blockerId !== null) {
      try {
        if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      } catch {
        // The Electron process exit remains the final non-persistent cleanup.
      }
    }
  }
}

const timeout = setTimeout(() => {
  process.stderr.write(`${MARKER} timeout\n`);
  app.exit(1);
}, TIMEOUT_MILLISECONDS);
timeout.unref();

verify().then(
  () => {
    clearTimeout(timeout);
    app.quit();
  },
  (error) => {
    clearTimeout(timeout);
    process.stderr.write(`${MARKER} failed: ${error?.stack ?? error}\n`);
    app.exit(1);
  },
);

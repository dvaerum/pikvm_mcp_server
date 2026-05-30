/**
 * Minimal WS server to verify the iPad app connects and round-trips
 * cleanly. Logs hello, runs clock-sync, fetches one cursor, then
 * subscribes for 5 s of streaming events.
 *
 * Usage: npx tsx bench-collect-smoke.ts
 * Then in the iPad app's settings: ws://<this-mac-ip>:8767
 */
import { startIpadAppServer } from '../src/pikvm/ipad-app-ws.ts';

const PORT = 8767;

console.log(`[smoke] starting WS server on ws://0.0.0.0:${PORT}`);

const server = startIpadAppServer({
  port: PORT,
  async onSession(sess) {
    console.log(`[smoke] session ${sess.id} hello:`, sess.hello);

    const sync = await sess.syncClock(5);
    console.log(`[smoke] clock sync: offset=${sync.offsetMs.toFixed(1)}ms rtt=${sync.rttMs.toFixed(1)}ms`);

    try {
      const c = await sess.getCursor();
      console.log(`[smoke] cursor: (${c.x.toFixed(1)}, ${c.y.toFixed(1)}) t_ipad=${c.t_ipad}`);
    } catch (e) {
      console.log(`[smoke] getCursor failed (no pointer on screen?): ${(e as Error).message}`);
    }

    let evCount = 0;
    sess.onCursorEvent = (ev) => {
      evCount++;
      if (evCount <= 20 || evCount % 50 === 0) {
        console.log(`[smoke] cursor-event #${evCount}: (${ev.x.toFixed(1)}, ${ev.y.toFixed(1)}) phase=${ev.phase}`);
      }
    };
    await sess.subscribeCursor();
    console.log('[smoke] subscribed to cursor stream — move the cursor on the iPad now');

    await new Promise((r) => setTimeout(r, 10_000));
    await sess.unsubscribeCursor();
    console.log(`[smoke] received ${evCount} events in 10 s`);
    console.log('[smoke] session done; server still running, Ctrl-C to quit');
  },
});

process.on('SIGINT', async () => {
  console.log('\n[smoke] shutting down');
  await server.close();
  process.exit(0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugPanelController } from '../src/ui/debugPanel.js';

test('debugPanel syncs hidden and inert state and caps log entries', () => {
  const state = {
    debugPanelOpen: false,
    debugLogs: [],
    fullAudioStatus: 'ready',
    activeSetId: '12345',
    providerOverride: 'mino',
    fullAudioError: '',
  };
  const debugPanel = { hidden: true, inert: true };
  const debugStatus = { textContent: '' };
  const debugLog = { textContent: '' };

  const panel = createDebugPanelController({
    state,
    debugPanel,
    debugStatus,
    debugLog,
    debugLogLimit: 3,
    getProviderDisplayName: (id) => id.toUpperCase(),
  });

  panel.render();
  assert.equal(debugPanel.hidden, true);
  assert.equal(debugPanel.inert, true);
  assert.equal(debugStatus.textContent, '', 'skips DOM updates while closed');

  panel.addLog('one');
  panel.addLog('two');
  panel.addLog('three');
  panel.addLog('four');
  assert.equal(state.debugLogs.length, 3);
  assert.deepEqual(state.debugLogs.map((e) => e.message), ['two', 'three', 'four']);

  panel.setOpen(true);
  assert.equal(debugPanel.hidden, false);
  assert.equal(debugPanel.inert, false);
  assert.match(debugStatus.textContent, /status: ready \| set 12345 \| provider MINO/);
  assert.match(debugLog.textContent, /two\n.*three\n.*four/);

  panel.clearLogs();
  assert.equal(debugLog.textContent, 'No logs yet.');

  panel.toggleOpen();
  assert.equal(debugPanel.hidden, true);
  assert.equal(debugPanel.inert, true);
});

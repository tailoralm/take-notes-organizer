const els = {
  banner: document.getElementById('banner'),
  transcribed: document.getElementById('transcribed-count'),
  pending: document.getElementById('pending-count'),
  toCopy: document.getElementById('tocopy-count'),
  refined: document.getElementById('refined-count'),
  copyBtn: document.getElementById('copy-btn'),
  copyLabel: document.getElementById('copy-btn-label'),
  copySpinner: document.getElementById('copy-spinner'),
  copyHint: document.getElementById('copy-hint'),
  processBtn: document.getElementById('process-btn'),
  processLabel: document.getElementById('process-btn-label'),
  processSpinner: document.getElementById('process-spinner'),
  processHint: document.getElementById('process-hint'),
  refineBtn: document.getElementById('refine-btn'),
  refineLabel: document.getElementById('refine-btn-label'),
  refineSpinner: document.getElementById('refine-spinner'),
  refineHint: document.getElementById('refine-hint'),
  stopBtn: document.getElementById('stop-btn'),
  stopLabel: document.getElementById('stop-btn-label'),
  stopSpinner: document.getElementById('stop-spinner'),
  stopHint: document.getElementById('stop-hint'),
  clearBtn: document.getElementById('clear-btn'),
  logPanel: document.getElementById('log-panel'),
};

const OPERATIONS = {
  copy: {
    endpoint: '/api/copy',
    starting: 'Requesting copy run...',
    idleLabel: 'Copy from origin',
    busyLabel: 'Copying',
    idleHint: 'Copies new voice notes from the origin folder',
    busyHint: 'Copying files, keep this tab open',
  },
  process: {
    endpoint: '/api/process',
    starting: 'Requesting transcription run...',
    idleLabel: 'Transcribe',
    busyLabel: 'Transcribing',
    idleHint: 'Transcribes files already in the output folder',
    busyHint: 'Transcriptions can take a while, keep this tab open',
  },
  refine: {
    endpoint: '/api/refine',
    starting: 'Requesting refine run...',
    idleLabel: 'Refine with LLM',
    busyLabel: 'Refining',
    idleHint: 'Refines transcribed notes into markdown via LMStudio',
    busyHint: 'The local LLM is working, keep this tab open',
  },
};

let running = null;
let stopping = false;

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Status request failed (${res.status})`);
    els.toCopy.textContent = String(data.toCopy);
    els.pending.textContent = String(data.pending);
    els.transcribed.textContent = String(data.transcribed);
    els.refined.textContent = String(data.refined);
    hideBanner();
  } catch (error) {
    showBanner(`Cannot load status: ${error.message}`);
  }
}

function appendLog(level, message) {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  const badge = document.createElement('span');
  badge.className = 'log-level';
  badge.textContent = level;
  const text = document.createElement('span');
  text.className = 'log-message';
  text.textContent = message;
  line.append(badge, text);
  els.logPanel.appendChild(line);

  const nearBottom = els.logPanel.scrollHeight - els.logPanel.scrollTop - els.logPanel.clientHeight < 40;
  if (nearBottom) els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function handleEvent(event) {
  if (event.type === 'log') {
    appendLog(event.level, event.message);
  } else if (event.type === 'error') {
    appendLog('error', event.message);
  } else if (event.type === 'stopped') {
    appendLog('warn', event.message || 'Operation stopped.');
  } else if (event.type === 'done') {
    const parts = [];
    if (typeof event.copied === 'number') parts.push(`${event.copied} copied`);
    if (typeof event.transcribed === 'number') parts.push(`${event.transcribed} transcribed`);
    if (typeof event.refined === 'number') parts.push(`${event.refined} refined`);
    appendLog('success', `Finished. ${parts.join(', ') || 'nothing to do'}.`);
  }
}

function setBusy(kind) {
  running = kind;
  const busy = kind !== null;

  els.copyBtn.disabled = busy;
  els.processBtn.disabled = busy;
  els.refineBtn.disabled = busy;

  // The stop button is the only one enabled while an operation runs.
  els.stopBtn.disabled = !busy || stopping;
  els.stopSpinner.hidden = !stopping;
  els.stopLabel.textContent = stopping ? 'Stopping' : 'Stop operation';
  els.stopHint.textContent = busy
    ? 'Stops the operation that is currently running'
    : 'Available while an operation is running';

  const copy = OPERATIONS.copy;
  els.copySpinner.hidden = kind !== 'copy';
  els.copyLabel.textContent = kind === 'copy' ? copy.busyLabel : copy.idleLabel;
  els.copyHint.textContent = kind === 'copy' ? copy.busyHint : copy.idleHint;

  const process = OPERATIONS.process;
  els.processSpinner.hidden = kind !== 'process';
  els.processLabel.textContent = kind === 'process' ? process.busyLabel : process.idleLabel;
  els.processHint.textContent = kind === 'process' ? process.busyHint : process.idleHint;

  const refine = OPERATIONS.refine;
  els.refineSpinner.hidden = kind !== 'refine';
  els.refineLabel.textContent = kind === 'refine' ? refine.busyLabel : refine.idleLabel;
  els.refineHint.textContent = kind === 'refine' ? refine.busyHint : refine.idleHint;
}

async function stopOperation() {
  if (!running || stopping) return;
  stopping = true;
  setBusy(running);
  appendLog('warn', 'Stopping the running operation...');

  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      stopping = false;
      setBusy(running);
      appendLog('error', data.error || `Could not stop the operation (${res.status}).`);
    }
  } catch (error) {
    stopping = false;
    setBusy(running);
    appendLog('error', `Could not stop the operation: ${error.message}`);
  }
}

async function runOperation(kind) {
  if (running) return;
  const operation = OPERATIONS[kind];

  setBusy(kind);
  els.logPanel.textContent = '';
  appendLog('info', operation.starting);

  try {
    const res = await fetch(operation.endpoint, { method: 'POST' });

    if (res.status === 409) {
      const data = await res.json();
      appendLog('error', data.error || 'Another run is already in progress.');
      return;
    }
    if (!res.ok) {
      let message = `Failed to start run (${res.status})`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch {
        message = await res.text();
      }
      appendLog('error', message);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed));
        } catch {
          appendLog('warn', `Unparseable log line: ${trimmed}`);
        }
      }
    }
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      try {
        handleEvent(JSON.parse(trimmed));
      } catch {
        appendLog('warn', `Unparseable log line: ${trimmed}`);
      }
    }
  } catch (error) {
    appendLog('error', `Connection error: ${error.message}`);
  } finally {
    stopping = false;
    setBusy(null);
    refreshStatus();
  }
}

els.copyBtn.addEventListener('click', () => runOperation('copy'));
els.processBtn.addEventListener('click', () => runOperation('process'));
els.refineBtn.addEventListener('click', () => runOperation('refine'));
els.stopBtn.addEventListener('click', stopOperation);
els.clearBtn.addEventListener('click', () => {
  els.logPanel.textContent = '';
});

refreshStatus();
setInterval(refreshStatus, 5000);

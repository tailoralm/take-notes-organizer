const els = {
  banner: document.getElementById('banner'),
  processed: document.getElementById('processed-count'),
  pending: document.getElementById('pending-count'),
  processBtn: document.getElementById('process-btn'),
  btnLabel: document.querySelector('.btn-label'),
  btnHint: document.getElementById('btn-hint'),
  spinner: document.querySelector('.spinner'),
  clearBtn: document.getElementById('clear-btn'),
  logPanel: document.getElementById('log-panel'),
};

let processing = false;

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
    els.processed.textContent = String(data.processed);
    els.pending.textContent = String(data.pending);
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
  } else if (event.type === 'done') {
    appendLog('success', `Finished. ${event.copied} copied, ${event.transcribed} transcribed.`);
  }
}

function setProcessing(active) {
  processing = active;
  els.processBtn.disabled = active;
  els.spinner.hidden = !active;
  els.btnLabel.textContent = active ? 'Processing' : 'Process now';
  els.btnHint.textContent = active
    ? 'Transcriptions can take a while, keep this tab open'
    : 'Transcribes all pending voice notes';
}

async function startProcessing() {
  if (processing) return;
  setProcessing(true);
  els.logPanel.textContent = '';
  appendLog('info', 'Requesting processing run...');

  try {
    const res = await fetch('/api/process', { method: 'POST' });

    if (res.status === 409) {
      const data = await res.json();
      appendLog('error', data.error || 'Another processing run is already in progress.');
      return;
    }
    if (!res.ok) {
      let message = `Failed to start processing (${res.status})`;
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
    setProcessing(false);
    refreshStatus();
  }
}

els.processBtn.addEventListener('click', startProcessing);
els.clearBtn.addEventListener('click', () => {
  els.logPanel.textContent = '';
});

refreshStatus();
setInterval(refreshStatus, 5000);
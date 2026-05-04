/**
 * LLM-Honeypot-Webui
 * @author Jaime Acosta
 * Frontend application logic
 */

// ===== Configuration =====
const API_BASE = '/api';
const POLL_INTERVAL = 5000; // ms
const RESTART_STATUS_POLL_INTERVAL = 1000; // ms
const RESTART_STATUS_TIMEOUT = 45000; // ms
let pollTimer = null;
let currentPage = 'dashboard';
let logSearchDebounceTimer = null;
let currentHoneypotStatus = 'unknown';
let settingsSaveInProgress = false;
let llmTestInProgress = false;
let llmTestedFingerprint = '';
let llmTestedConnectionSignature = '';
let llmTestStatus = 'untested';
let llmTestMessage = 'Run Test LLM in LLM Settings before starting the honeypot.';
let llmTestedAt = '';
let currentStartAllowed = true;
let currentStartBlockReason = '';

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
    startPolling();

    // Custom model dropdown toggle
    const modelSelect = document.getElementById('settOpenAIModel');
    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            const customGroup = document.getElementById('openaiCustomModelGroup');
            customGroup.style.display = modelSelect.value === 'custom' ? 'block' : 'none';
        });
    }

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('input', syncLLMTestStateWithForm);
        settingsForm.addEventListener('change', syncLLMTestStateWithForm);
    }
});

// ===== Navigation =====
function navigateTo(page) {
    currentPage = page;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Update page views
    document.querySelectorAll('.page-view').forEach(view => {
        view.classList.toggle('active', view.id === `page-${page}`);
    });

    // Load page-specific data
    switch (page) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'logs':
            loadLogs();
            break;
        case 'sessions':
            loadSessions();
            break;
        case 'config':
            loadConfig();
            break;
        case 'settings':
            loadSettingsForm();
            break;
    }

    // Close mobile sidebar
    if (window.innerWidth <= 1024) {
        toggleSidebar(false);
    }
}

// ===== Sidebar Toggle (mobile) =====
function toggleSidebar(forceState) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const isOpen = typeof forceState === 'boolean' ? forceState : !sidebar.classList.contains('open');

    sidebar.classList.toggle('open', isOpen);
    overlay.classList.toggle('active', isOpen);
}

// ===== Polling =====
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        refreshStatus();
        if (currentPage === 'dashboard') {
            loadStats();
        }
    }, POLL_INTERVAL);
}

// ===== API Client =====
async function apiFetch(endpoint, options = {}) {
    const { expectTransientUnavailable = false, ...fetchOptions } = options;

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            headers: { 'Content-Type': 'application/json', ...fetchOptions.headers },
            ...fetchOptions,
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        if (err.name === 'TypeError' || err.name === 'AbortError') {
            const rawMessage = typeof err.message === 'string' && err.message.trim()
                ? err.message.trim()
                : err.name;

            if (navigator.onLine === false) {
                const offlineError = new Error('Your browser appears to be offline. Reconnect and try again.');
                offlineError.code = 'browser-offline';
                throw offlineError;
            }

            if (expectTransientUnavailable) {
                const restartError = new Error(`The management API is temporarily unavailable while the honeypot restarts (${rawMessage}).`);
                restartError.code = 'api-restarting';
                throw restartError;
            }

            const networkError = new Error(`The management API could not be reached (${rawMessage}).`);
            networkError.code = 'api-unreachable';
            throw networkError;
        }
        throw err;
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function setInterfaceLocked(isLocked) {
    const appShell = document.getElementById('appShell');
    const mobileMenuButton = document.getElementById('mobileMenuBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    document.body.setAttribute('aria-busy', isLocked ? 'true' : 'false');

    if (appShell) {
        if (isLocked) {
            appShell.setAttribute('inert', '');
            appShell.setAttribute('aria-hidden', 'true');
        } else {
            appShell.removeAttribute('inert');
            appShell.removeAttribute('aria-hidden');
        }
    }

    if (mobileMenuButton) {
        mobileMenuButton.disabled = isLocked;
        mobileMenuButton.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
    }

    if (sidebarOverlay) {
        sidebarOverlay.style.pointerEvents = isLocked ? 'none' : '';
    }

    if (isLocked && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
}

function showRestartOverlay(title, message) {
    const overlay = document.getElementById('loadingOverlay');
    const titleEl = document.getElementById('loadingTitle');
    const messageEl = document.getElementById('loadingMessage');

    setInterfaceLocked(true);

    if (!overlay || !titleEl || !messageEl) {
        return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    overlay.classList.add('active');
    document.body.classList.add('overlay-open');
}

function hideRestartOverlay() {
    const overlay = document.getElementById('loadingOverlay');

    setInterfaceLocked(false);

    if (!overlay) {
        return;
    }

    overlay.classList.remove('active');
    document.body.classList.remove('overlay-open');
}

async function paintRestartOverlay(title, message) {
    showRestartOverlay(title, message);
    await nextPaint();
}

async function waitForHoneypotRunning() {
    const deadline = Date.now() + RESTART_STATUS_TIMEOUT;
    let lastStatus = currentHoneypotStatus;
    let lastError = null;

    while (Date.now() < deadline) {
        try {
            const data = await apiFetch('/status', { expectTransientUnavailable: true });
            updateStatusUI(data);
            lastStatus = data.status || 'unknown';

            if (lastStatus === 'running') {
                return data;
            }

            if (['exited', 'dead', 'not_found'].includes(lastStatus)) {
                throw new Error(`Honeypot restart failed: status is ${lastStatus}`);
            }
        } catch (err) {
            lastError = err;
        }

        await delay(RESTART_STATUS_POLL_INTERVAL);
    }

    if (lastError?.code === 'api-restarting') {
        throw new Error('The honeypot restart is taking longer than expected. The management API stayed unavailable during the restart window.');
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error(`Timed out waiting for honeypot restart (last status: ${lastStatus})`);
}

// ===== Status Management =====
async function refreshStatus() {
    try {
        const data = await apiFetch('/status');
        updateStatusUI(data);
    } catch (err) {
        updateStatusUI({ status: 'unknown', message: err.message || 'API unreachable' });
    }
}

function updateStatusUI(data) {
    const status = data.status || 'unknown';
    currentHoneypotStatus = status;
    currentStartAllowed = data.start_allowed !== false;
    currentStartBlockReason = data.start_block_reason || '';
    const dot = document.getElementById('statusDot');
    const title = document.getElementById('statusTitle');
    const subtitle = document.getElementById('statusSubtitle');
    const sidebarDot = document.getElementById('sidebarStatusDot');
    const sidebarText = document.getElementById('sidebarStatusText');
    const sidebarBadge = document.getElementById('sidebarStatus');

    // Main status
    dot.className = `status-dot-large ${status}`;

    const statusLabels = {
        running: 'Honeypot Running',
        exited: 'Honeypot Stopped',
        stopped: 'Honeypot Stopped',
        created: 'Honeypot Created',
        restarting: 'Honeypot Restarting...',
        not_found: 'Container Not Found',
        unknown: 'Status Unknown',
    };

    title.textContent = statusLabels[status] || `Status: ${status}`;

    if (status === 'running' && data.uptime != null) {
        subtitle.textContent = `Uptime: ${formatUptime(data.uptime)} • Container: ${data.container_name || 'N/A'}`;
        if (currentStartBlockReason) {
            subtitle.textContent += ` • ${currentStartBlockReason}`;
        }
    } else if (currentStartBlockReason) {
        subtitle.textContent = currentStartBlockReason;
    } else if (data.message) {
        subtitle.textContent = data.message;
    } else {
        subtitle.textContent = `Container: ${data.container_name || 'N/A'}`;
    }

    // Button states
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const btnRestart = document.getElementById('btnRestart');

    btnStart.disabled = status === 'running' || !currentStartAllowed;
    btnStop.disabled = status !== 'running';
    btnRestart.disabled = status !== 'running' || !currentStartAllowed;
    btnStart.title = currentStartAllowed ? '' : currentStartBlockReason;
    btnRestart.title = currentStartAllowed ? '' : currentStartBlockReason;

    // Sidebar status
    const isRunning = status === 'running';
    sidebarDot.className = `status-dot-small ${isRunning ? 'running' : 'stopped'}`;
    sidebarText.textContent = isRunning ? 'Cowrie Running' : 'Cowrie Stopped';
    sidebarBadge.className = `status-badge-sidebar ${isRunning ? '' : 'stopped'}`;
}

// ===== Honeypot Control =====
async function controlHoneypot(action) {
    if ((action === 'start' || action === 'restart') && !currentStartAllowed) {
        showToast(currentStartBlockReason || 'Run Test LLM before starting the honeypot.', 'warning');
        return;
    }

    const btn = document.getElementById(`btn${action.charAt(0).toUpperCase() + action.slice(1)}`);
    const originalHTML = btn.innerHTML;
    const actionLabel = {
        start: 'Starting',
        stop: 'Stopping',
        restart: 'Restarting',
    }[action] || `${action}ing`;

    try {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> ${actionLabel}...`;

        const data = await apiFetch(`/${action}`, { method: 'POST' });
        showToast(data.message || `Honeypot ${action}ed`, 'success');
        await refreshStatus();
    } catch (err) {
        showToast(`Failed to ${action}: ${err.message}`, 'error');
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        await refreshStatus();
    }
}

// ===== Dashboard =====
async function loadDashboard() {
    await refreshStatus();
    await loadStats();
}

async function loadStats() {
    try {
        const data = await apiFetch('/logs/stats');
        updateStatsUI(data);
    } catch (err) {
        // Stats may not be available yet
    }
}

function updateStatsUI(data) {
    // Stats cards
    animateCounter('statTotalEvents', data.total_events || 0);
    animateCounter('statLoginAttempts', data.login_attempts || 0);
    animateCounter('statSuccessLogins', data.successful_logins || 0);
    animateCounter('statCommands', data.commands_entered || 0);
    animateCounter('statUniqueIPs', data.unique_ips || 0);

    // Top lists
    renderTopList('topUsernames', data.top_usernames || []);
    renderTopList('topPasswords', data.top_passwords || []);
    renderTopList('topIPs', data.top_ips || []);
    renderTopList('topCommands', data.top_commands || [], true);
}

function renderTopList(elementId, items, isCode = false) {
    const el = document.getElementById(elementId);
    if (!items || items.length === 0) {
        el.innerHTML = '<li class="empty-state"><p>No data yet</p></li>';
        return;
    }

    el.innerHTML = items.map(([name, count], i) => `
        <li class="top-list-item">
            <span class="top-list-rank">${i + 1}.</span>
            <span class="item-name">${isCode ? `<code>${escapeHtml(name)}</code>` : escapeHtml(name)}</span>
            <span class="item-count">${count.toLocaleString()}</span>
        </li>
    `).join('');
}

function animateCounter(elementId, target) {
    const el = document.getElementById(elementId);
    const current = parseInt(el.textContent.replace(/[^0-9]/g, '')) || 0;

    if (current === target) {
        el.textContent = target.toLocaleString();
        return;
    }

    const duration = 400;
    const startTime = performance.now();

    function tick(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
        const value = Math.round(current + (target - current) * eased);
        el.textContent = value.toLocaleString();
        if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
}

// ===== Log Viewer =====
function debounceLogSearch() {
    clearTimeout(logSearchDebounceTimer);
    logSearchDebounceTimer = setTimeout(() => loadLogs(), 350);
}

async function loadLogs() {
    const search = document.getElementById('logSearch')?.value || '';
    const eventFilter = document.getElementById('logEventFilter')?.value || '';
    const tbody = document.getElementById('logTableBody');

    try {
        const params = new URLSearchParams({ limit: 200 });
        if (search) params.set('search', search);
        if (eventFilter) params.set('event', eventFilter);

        const data = await apiFetch(`/logs?${params}`);
        const entries = data.entries || [];

        if (entries.length === 0) {
            tbody.innerHTML = `
                <tr><td colspan="5">
                    <div class="empty-state">
                        <div class="empty-icon">📋</div>
                        <h3>No log entries${search ? ' matching your search' : ''}</h3>
                        <p>Logs will appear here once the honeypot captures activity</p>
                    </div>
                </td></tr>`;
            return;
        }

        tbody.innerHTML = entries.map(entry => {
            const eventId = entry.eventid || '';
            const shortEvent = eventId.replace('cowrie.', '');
            const badgeClass = getEventBadgeClass(eventId);
            const details = getEventDetails(entry);
            const timestamp = formatTimestamp(entry.timestamp);
            const srcIp = entry.src_ip || '—';
            const session = entry.session ? entry.session.substring(0, 8) : '—';

            return `
                <tr>
                    <td style="white-space: nowrap; font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-tertiary);">${timestamp}</td>
                    <td><span class="event-badge ${badgeClass}">${escapeHtml(shortEvent)}</span></td>
                    <td style="font-family: var(--font-mono); font-size: 0.82rem;">${escapeHtml(srcIp)}</td>
                    <td>${details}</td>
                    <td style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-tertiary);">${escapeHtml(session)}</td>
                </tr>`;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `
            <tr><td colspan="5">
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <h3>Error loading logs</h3>
                    <p>${escapeHtml(err.message)}</p>
                </div>
            </td></tr>`;
    }
}

function getEventBadgeClass(eventId) {
    if (eventId.includes('login.success')) return 'login-success';
    if (eventId.includes('login.failed')) return 'login-failed';
    if (eventId.includes('command')) return 'command';
    if (eventId.includes('session')) return 'session';
    if (eventId.includes('llm')) return 'llm';
    return 'default';
}

function getEventDetails(entry) {
    const eventId = entry.eventid || '';

    if (eventId.includes('login')) {
        const user = escapeHtml(entry.username || '');
        const pass = escapeHtml(entry.password || '');
        return `<span style="color: var(--text-primary);">${user}</span> <span style="color: var(--text-tertiary);">:</span> <span class="command-text">${pass}</span>`;
    }

    if (eventId.includes('command.input')) {
        return `<span class="command-text">${escapeHtml(entry.input || '')}</span>`;
    }

    if (eventId.includes('session.connect')) {
        return `Protocol: ${escapeHtml(entry.protocol || 'ssh')}`;
    }

    if (eventId.includes('llm')) {
        let title = '';
        let content = '';
        let cssClass = '';

        if (eventId.includes('request')) {
            title = 'Full Prompt History';
            const fullPrompt = entry.prompt || '';
            const userMatch = fullPrompt.match(/\[USER\]\n([\s\S]*)/);
            const userContent = userMatch ? userMatch[1].trim() : (entry.input && entry.input !== '-' ? entry.input : 'Honeypot Initialization');
            
            cssClass = 'llm-prompt';
            
            return `
                <div class="llm-details">
                    <div style="font-weight: 500;">User Action: <span class="command-text" style="color: var(--accent-cyan); background: rgba(14, 165, 233, 0.05); border-left: 2px solid var(--accent-cyan);">${escapeHtml(userContent)}</span></div>
                    <div class="llm-content-wrapper">
                        <div style="font-size: 0.7rem; color: var(--text-tertiary); margin: 12px 0 4px 0;">${title}</div>
                        <div class="${cssClass}">${escapeHtml(fullPrompt || entry.message || '')}</div>
                    </div>
                    <div class="llm-actions">
                        <button class="btn-mini" onclick="toggleLLMExpand(this)">↔ Expand Context</button>
                        <button class="btn-mini" onclick="downloadContent(this, 'prompt.txt')">💾 Download</button>
                    </div>
                </div>`;
        } else if (eventId.includes('response')) {
            title = 'AI Response Content';
            content = entry.response || entry.message || '';
            cssClass = 'llm-response';
            
            return `
                <div class="llm-details">
                    <div style="font-weight: 500;">AI Result: <span class="command-text" style="color: var(--accent-emerald); background: rgba(52, 211, 153, 0.05);">${escapeHtml(content.substring(0, 50))}...</span></div>
                    <div class="llm-content-wrapper">
                        <div style="font-size: 0.7rem; color: var(--text-tertiary); margin: 12px 0 4px 0;">${title}</div>
                        <div class="${cssClass}">${escapeHtml(content)}</div>
                    </div>
                    <div class="llm-actions">
                        <button class="btn-mini" onclick="toggleLLMExpand(this)">↔ Expand Response</button>
                        <button class="btn-mini" onclick="downloadContent(this, 'response.txt')">💾 Download</button>
                    </div>
                </div>`;
        } else if (eventId.includes('error')) {
            title = 'AI Backend Error';
            const errorText = entry.error || 'Unknown API Error';
            const status = entry.status || '???';
            
            return `
                <div class="llm-details">
                    <div class="llm-error-box">
                        <div class="llm-error-header">
                            <span class="status-badge-error">Status ${status}</span>
                            <strong>${title}</strong>
                        </div>
                        <div class="llm-error-content">${escapeHtml(errorText)}</div>
                    </div>
                </div>`;
        }
    }

    if (entry.message) {
        const msg = typeof entry.message === 'string' ? entry.message : JSON.stringify(entry.message);
        return escapeHtml(msg.substring(0, 100));
    }

    return '—';
}

function toggleLLMExpand(btn) {
    const wrapper = btn.closest('.llm-details').querySelector('.llm-content-wrapper');
    const isExpanded = wrapper.classList.toggle('expanded');
    btn.textContent = isExpanded ? '↔ Collapse' : '↔ Expand';
}

function downloadContent(btn, filename) {
    const content = btn.closest('.llm-details').querySelector('.llm-prompt, .llm-response').textContent;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

// ===== Sessions =====
async function loadSessions() {
    const container = document.getElementById('sessionsList');

    try {
        const data = await apiFetch('/logs/sessions');
        const sessions = data.sessions || [];

        if (sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🔗</div>
                    <h3>No sessions recorded</h3>
                    <p>Sessions will appear here once attackers connect to the honeypot</p>
                </div>`;
            return;
        }

        container.innerHTML = sessions.map(session => {
            const cmds = session.commands || [];
            const cmdHtml = cmds.length > 0
                ? `<div class="session-commands">${cmds.slice(0, 15).map(c => `<code>$ ${escapeHtml(c)}</code>`).join('')}${cmds.length > 15 ? `<span style="color: var(--text-tertiary); font-size: 0.78rem;">... and ${cmds.length - 15} more</span>` : ''}</div>`
                : '';

            return `
                <div class="session-card">
                    <div class="session-header">
                        <span class="session-ip">${escapeHtml(session.src_ip)}</span>
                        <span class="session-time">${formatTimestamp(session.start_time)}</span>
                    </div>
                    <div class="session-meta">
                        <span>👤 ${escapeHtml(session.username || 'unknown')}</span>
                        <span>📡 ${escapeHtml(session.protocol || 'ssh')}</span>
                        <span>📋 ${session.events} events</span>
                        <span>⌨️ ${cmds.length} commands</span>
                    </div>
                    ${cmdHtml}
                </div>`;
        }).join('');

    } catch (err) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <h3>Error loading sessions</h3>
                <p>${escapeHtml(err.message)}</p>
            </div>`;
    }
}

// ===== Configuration =====
async function loadConfig() {
    try {
        const settings = await apiFetch('/settings');
        document.getElementById('cfgHostname').value = settings.cowrie_hostname || 'svr04';
        document.getElementById('cfgBackend').value = settings.cowrie_backend || 'shell';
        document.getElementById('cfgSSHEnabled').checked = settings.ssh_enabled !== false;
        document.getElementById('cfgSSHPort').value = settings.ssh_port || 2222;
        document.getElementById('cfgSSHVersion').value = settings.ssh_version || 'SSH-2.0-OpenSSH_6.0p1 Debian-4+deb7u2';
        document.getElementById('cfgTelnetEnabled').checked = settings.telnet_enabled !== false;
        document.getElementById('cfgTelnetPort').value = settings.telnet_port || 2223;
    } catch (err) {
        // Use defaults
    }
}

async function saveConfig(event) {
    event.preventDefault();

    const statusSnapshot = await apiFetch('/status').catch(() => ({ status: currentHoneypotStatus }));
    updateStatusUI(statusSnapshot);

    const payload = {
        cowrie_hostname: document.getElementById('cfgHostname').value,
        cowrie_backend: document.getElementById('cfgBackend').value,
        ssh_enabled: document.getElementById('cfgSSHEnabled').checked,
        ssh_port: parseInt(document.getElementById('cfgSSHPort').value) || 2222,
        ssh_version: document.getElementById('cfgSSHVersion').value,
        telnet_enabled: document.getElementById('cfgTelnetEnabled').checked,
        telnet_port: parseInt(document.getElementById('cfgTelnetPort').value) || 2223,
        auto_restart: document.getElementById('cfgAutoRestart').checked,
    };

    const shouldBlockForRestart = payload.auto_restart && statusSnapshot.status === 'running';

    try {
        if (shouldBlockForRestart) {
            await paintRestartOverlay(
                'Applying configuration',
                'Stopping the honeypot, waiting briefly, and bringing it back online. The interface will unlock once it is healthy again.'
            );
        }

        const result = await apiFetch('/config', {
            method: 'PUT',
            body: JSON.stringify(payload),
        });

        if (shouldBlockForRestart && result.restarted) {
            await waitForHoneypotRunning();
        }

        showToast(result.message || 'Configuration saved successfully', result.test_required ? 'info' : 'success');
        if (result.restarted) {
            showToast('Honeypot restart completed', 'info');
        } else if (result.test_required) {
            showToast('Start and restart remain blocked until Test LLM passes for the saved configuration.', 'info');
        }
    } catch (err) {
        showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
        if (shouldBlockForRestart) {
            hideRestartOverlay();
        }
        await refreshStatus();
    }
}

// ===== LLM Settings =====
function selectProvider(provider) {
    document.querySelectorAll('.provider-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.provider === provider);
    });

    document.getElementById('openaiSettings').style.display = provider === 'openai' ? 'block' : 'none';
    document.getElementById('ollamaSettings').style.display = provider === 'ollama' ? 'block' : 'none';
    syncLLMTestStateWithForm();
}

function getSelectedProvider() {
    return document.querySelector('.provider-card.selected')?.dataset.provider || 'openai';
}

function getSelectedOpenAIModel() {
    const openaiModel = document.getElementById('settOpenAIModel').value;
    if (openaiModel === 'custom') {
        return document.getElementById('settOpenAICustomModel').value || 'gpt-4o-mini';
    }
    return openaiModel;
}

function buildLLMSettingsPayload(includeHistory = true) {
    const payload = {
        llm_provider: getSelectedProvider(),
        openai_api_key: document.getElementById('settApiKey').value,
        openai_host: document.getElementById('settOpenAIHost').value,
        openai_model: getSelectedOpenAIModel(),
        ollama_host: document.getElementById('settOllamaHost').value,
        ollama_model: document.getElementById('settOllamaModel').value,
        llm_temperature: parseFloat(document.getElementById('settTemperature').value) || 0.7,
        llm_max_tokens: parseInt(document.getElementById('settMaxTokens').value) || 500,
        llm_debug: document.getElementById('settDebug').checked,
    };

    if (includeHistory) {
        payload.openai_host_history = updateHistoryArray('openaiHostHistory', payload.openai_host);
        payload.ollama_host_history = updateHistoryArray('ollamaHostHistory', payload.ollama_host);
    }

    return payload;
}

function getLLMConnectionSignature(payload = buildLLMSettingsPayload(false)) {
    const provider = payload.llm_provider || 'openai';
    const signature = {
        llm_provider: provider,
        openai_host: provider === 'openai' ? (payload.openai_host || '').trim() : '',
        openai_model: provider === 'openai' ? (payload.openai_model || '').trim() : '',
        openai_api_key: provider === 'openai' ? (payload.openai_api_key || '').trim() : '',
        ollama_host: provider === 'ollama' ? (payload.ollama_host || '').trim() : '',
        ollama_model: provider === 'ollama' ? (payload.ollama_model || '').trim() : '',
    };

    return JSON.stringify(signature);
}

function isCurrentLLMFormTested() {
    return Boolean(llmTestedFingerprint) && getLLMConnectionSignature() === llmTestedConnectionSignature;
}

function formatLLMTestTimestamp(timestamp) {
    if (!timestamp) {
        return '';
    }

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return timestamp;
    }

    return date.toLocaleString();
}

function updateLLMTestUI() {
    const badge = document.getElementById('llmTestBadge');
    const message = document.getElementById('llmTestMessage');
    const meta = document.getElementById('llmTestMeta');
    const testButton = document.getElementById('btnTestLLM');
    const saveHint = document.getElementById('llmSaveHint');
    const hasCurrentTest = isCurrentLLMFormTested();

    if (badge) {
        badge.className = 'llm-test-badge pending';
    }

    if (llmTestInProgress) {
        if (badge) {
            badge.textContent = 'Testing';
        }
        if (message) {
            message.textContent = 'Checking the configured provider, credentials, and model availability.';
        }
        if (meta) {
            meta.textContent = '';
        }
    } else if (hasCurrentTest) {
        if (badge) {
            badge.className = 'llm-test-badge passed';
            badge.textContent = 'Verified';
        }
        if (message) {
            message.textContent = llmTestMessage || 'Connection test passed for the current settings.';
        }
        if (meta) {
            meta.textContent = llmTestedAt ? `Last successful test: ${formatLLMTestTimestamp(llmTestedAt)}` : '';
        }
    } else {
        if (badge) {
            badge.className = `llm-test-badge ${llmTestStatus === 'failed' ? 'failed' : 'pending'}`;
            badge.textContent = llmTestStatus === 'failed' ? 'Failed' : 'Test required';
        }
        if (message) {
            message.textContent = llmTestMessage || 'Run Test LLM in LLM Settings before starting the honeypot.';
        }
        if (meta) {
            meta.textContent = llmTestedAt && llmTestStatus === 'failed'
                ? `Last failed test: ${formatLLMTestTimestamp(llmTestedAt)}`
                : '';
        }
    }

    if (testButton) {
        testButton.disabled = llmTestInProgress || settingsSaveInProgress;
        testButton.innerHTML = llmTestInProgress
            ? '<span class="spinner"></span> Testing...'
            : 'Test LLM';
    }

    if (saveHint) {
        saveHint.textContent = hasCurrentTest
            ? 'Settings are applied to cowrie.cfg. This LLM configuration has been verified and is ready to save/start.'
            : 'Settings are applied to cowrie.cfg. Run Test LLM before starting the honeypot when the LLM backend is active.';
    }
}

function syncLLMTestStateWithForm() {
    if (llmTestInProgress) {
        return;
    }

    if (!isCurrentLLMFormTested() && (llmTestStatus === 'passed' || llmTestedFingerprint)) {
        llmTestStatus = 'untested';
        llmTestMessage = 'Connection settings changed. Re-run Test LLM before starting the honeypot.';
        llmTestedFingerprint = '';
        llmTestedConnectionSignature = '';
        llmTestedAt = '';
    }

    updateLLMTestUI();
}

async function testLLMConnection() {
    if (llmTestInProgress || settingsSaveInProgress) {
        return;
    }

    const payload = buildLLMSettingsPayload(false);

    try {
        llmTestInProgress = true;
        llmTestStatus = 'untested';
        llmTestMessage = 'Checking the configured provider, credentials, and model availability.';
        updateLLMTestUI();

        const result = await apiFetch('/llm/test', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        llmTestStatus = 'passed';
        llmTestMessage = result.message || 'Connection test passed for the current settings.';
        llmTestedAt = result.tested_at || '';
        llmTestedFingerprint = result.fingerprint || '';
        llmTestedConnectionSignature = getLLMConnectionSignature(payload);

        updateLLMTestUI();
        showToast(
            result.persisted
                ? 'LLM connection verified for the saved configuration'
                : 'LLM connection verified. Save Settings to apply this tested configuration.',
            'success'
        );
    } catch (err) {
        llmTestStatus = 'failed';
        llmTestMessage = err.message;
        llmTestedAt = new Date().toISOString();
        llmTestedFingerprint = '';
        llmTestedConnectionSignature = '';
        updateLLMTestUI();
        showToast(`LLM test failed: ${err.message}`, 'error');
    } finally {
        llmTestInProgress = false;
        updateLLMTestUI();
        await refreshStatus();
    }
}

async function loadSettingsForm() {
    try {
        const settings = await apiFetch('/settings');

        // Provider
        const provider = settings.llm_provider || 'openai';
        selectProvider(provider);

        // OpenAI
        document.getElementById('settOpenAIHost').value = settings.openai_host || 'https://api.openai.com';
        populateHistory('openaiHostHistory', settings.openai_host_history || ['https://api.openai.com']);
        
        if (settings.openai_api_key) {
            document.getElementById('settApiKey').value = settings.openai_api_key;
        } else {
            document.getElementById('settApiKey').value = '';
            document.getElementById('settApiKey').placeholder = settings.openai_api_key_masked || 'sk-...';
        }

        const model = settings.openai_model || 'gpt-4o-mini';
        const modelSelect = document.getElementById('settOpenAIModel');
        
        // Ensure the current model is in the options or added as custom
        let found = false;
        for (let i = 0; i < modelSelect.options.length; i++) {
            if (modelSelect.options[i].value === model) {
                modelSelect.value = model;
                found = true;
                break;
            }
        }
        
        if (!found) {
            modelSelect.value = 'custom';
            document.getElementById('openaiCustomModelGroup').style.display = 'block';
            document.getElementById('settOpenAICustomModel').value = model;
        }

        // Ollama
        document.getElementById('settOllamaHost').value = settings.ollama_host || 'http://host.docker.internal:11434';
        populateHistory('ollamaHostHistory', settings.ollama_host_history || ['http://host.docker.internal:11434', 'http://ollama:11434']);
        document.getElementById('settOllamaModel').value = settings.ollama_model || 'llama3';

        // Common
        document.getElementById('settTemperature').value = settings.llm_temperature ?? 0.7;
        document.getElementById('settMaxTokens').value = settings.llm_max_tokens ?? 500;
        document.getElementById('settDebug').checked = settings.llm_debug === true;

        llmTestStatus = settings.llm_last_test_status || 'untested';
        llmTestMessage = settings.llm_test_current
            ? (settings.llm_last_test_message || 'Connection test passed for the current settings.')
            : (settings.llm_test_required_message || 'Run Test LLM in LLM Settings before starting the honeypot.');
        llmTestedAt = settings.llm_last_tested_at || '';
        llmTestedFingerprint = settings.llm_test_current ? (settings.llm_last_tested_fingerprint || '') : '';
        llmTestedConnectionSignature = settings.llm_test_current ? getLLMConnectionSignature() : '';
        updateLLMTestUI();

    } catch (err) {
        // Use defaults
        updateLLMTestUI();
    }
}

async function saveSettings(event) {
    event.preventDefault();

    if (settingsSaveInProgress) {
        return;
    }

    settingsSaveInProgress = true;

    const submitButton = event.submitter || document.querySelector('#settingsForm button[type="submit"]');
    const originalButtonText = submitButton?.innerHTML;

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = 'Saving...';
    }

    await paintRestartOverlay(
        'Saving LLM settings',
        'Applying your LLM configuration now. If the honeypot is running, the interface will stay locked until the restart finishes.'
    );

    try {
        const statusSnapshot = await apiFetch('/status').catch(() => ({ status: currentHoneypotStatus }));
        updateStatusUI(statusSnapshot);

        const payload = buildLLMSettingsPayload(true);
        if (isCurrentLLMFormTested() && llmTestedFingerprint) {
            payload.llm_tested_fingerprint = llmTestedFingerprint;
        }

        const shouldBlockForRestart = statusSnapshot.status === 'running';

        if (shouldBlockForRestart) {
            showRestartOverlay(
                'Applying LLM settings',
                'Saving your LLM configuration and fully restarting the honeypot. The interface will unlock once the service is back online.'
            );
        }

        const result = await apiFetch('/settings', {
            method: 'PUT',
            body: JSON.stringify(payload),
        });

        if (result.llm_test_current && result.llm_last_tested_fingerprint) {
            llmTestStatus = result.llm_last_test_status || 'passed';
            llmTestMessage = result.llm_last_test_message || result.message || 'Connection test passed for the current settings.';
            llmTestedAt = result.llm_last_tested_at || llmTestedAt;
            llmTestedFingerprint = result.llm_last_tested_fingerprint;
            llmTestedConnectionSignature = getLLMConnectionSignature(payload);
        } else {
            llmTestStatus = 'untested';
            llmTestMessage = result.llm_last_test_message || result.message || 'Run Test LLM before starting the honeypot.';
            llmTestedAt = '';
            llmTestedFingerprint = '';
            llmTestedConnectionSignature = '';
        }

        updateLLMTestUI();

        if (shouldBlockForRestart && result.restarted) {
            await waitForHoneypotRunning();
        }

        showToast(result.message || 'LLM settings saved successfully', result.test_required ? 'info' : 'success');
        if (result.restarted) {
            showToast('Honeypot fully restarted to apply LLM settings', 'info');
        } else if (result.test_required) {
            showToast('Start and restart remain blocked until Test LLM passes for the saved configuration.', 'info');
        }
    } catch (err) {
        showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
        settingsSaveInProgress = false;

        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = originalButtonText || 'Save Settings';
        }

        if (document.getElementById('loadingOverlay')?.classList.contains('active')) {
            hideRestartOverlay();
        }

        await refreshStatus();
    }
}

async function fetchModels(provider) {
    const host = document.getElementById(provider === 'openai' ? 'settOpenAIHost' : 'settOllamaHost').value;
    const apiKey = provider === 'openai' ? document.getElementById('settApiKey').value : '';
    
    if (!host) {
        showToast('Host URL is required to fetch models', 'warning');
        return;
    }

    showToast(`Fetching models from ${provider}...`, 'info');
    
    try {
        const params = new URLSearchParams({ provider, host });
        if (apiKey) params.set('api_key', apiKey);
        
        const data = await apiFetch(`/llm/models?${params}`);
        
        // Update history immediately on success
        if (provider === 'openai') {
            updateHistoryArray('openaiHostHistory', host);
        } else {
            updateHistoryArray('ollamaHostHistory', host);
        }

        const models = data.models || [];
        
        if (models.length === 0) {
            showToast('No models found', 'warning');
            return;
        }

        if (provider === 'openai') {
            const select = document.getElementById('settOpenAIModel');
            const currentModel = select.value === 'custom' ? document.getElementById('settOpenAICustomModel').value : select.value;
            
            // Rebuild options including custom entry
            select.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('') + 
                             '<option value="custom">Custom Model...</option>';
            
            // Try to restore selection
            let restored = false;
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].value === currentModel) {
                    select.value = currentModel;
                    restored = true;
                    break;
                }
            }
            
            if (!restored) {
                select.value = 'custom';
                document.getElementById('openaiCustomModelGroup').style.display = 'block';
                document.getElementById('settOpenAICustomModel').value = currentModel;
            }
            
        } else if (provider === 'ollama') {
            const container = document.getElementById('ollamaModelContainer');
            const currentModel = document.getElementById('settOllamaModel').value;
            
            // Switch input to select for Ollama
            container.innerHTML = `
                <div style="display: flex; gap: 8px;">
                    <select class="form-select mono" id="settOllamaModel" style="flex: 1;">
                        ${models.map(m => `<option value="${m}">${m}</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-ghost" title="Switch to manual input" onclick="switchToManualOllama('${currentModel}')">✎</button>
                </div>
            `;
            
            const select = document.getElementById('settOllamaModel');
            // Try to restore selection
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].value === currentModel) {
                    select.value = currentModel;
                    break;
                }
            }
        }
        
        showToast(`Successfully fetched ${models.length} models`, 'success');
        syncLLMTestStateWithForm();
        
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function switchToManualOllama(currentValue) {
    const container = document.getElementById('ollamaModelContainer');
    container.innerHTML = `
        <input type="text" class="form-input mono" id="settOllamaModel" value="${currentValue}" placeholder="llama3">
    `;
    syncLLMTestStateWithForm();
}

function populateHistory(datalistId, history) {
    const datalist = document.getElementById(datalistId);
    if (!datalist) return;
    datalist.innerHTML = history.map(h => `<option value="${h}"></option>`).join('');
}

function updateHistoryArray(datalistId, newUrl) {
    if (!newUrl) return [];
    
    const datalist = document.getElementById(datalistId);
    if (!datalist) return [];

    let history = Array.from(datalist.options).map(opt => opt.value);
    
    // Add new URL to front if not present, or move to front if present
    history = history.filter(h => h !== newUrl);
    history.unshift(newUrl);
    
    // Limit to 10 entries
    history = history.slice(0, 10);
    
    // Re-populate UI
    populateHistory(datalistId, history);
    
    return history;
}

// ===== Toast Notifications =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <span>${escapeHtml(message)}</span>
        <span class="toast-dismiss" onclick="dismissToast(this)">✕</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function dismissToast(el) {
    const toast = el.closest('.toast');
    toast.style.animation = 'slideOutRight 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
}

// ===== Utility Functions =====
function formatUptime(seconds) {
    if (seconds == null) return 'N/A';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

function formatTimestamp(ts) {
    if (!ts) return '—';
    try {
        const d = new Date(ts);
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        return ts;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

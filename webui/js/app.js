/**
 * LLM-Honeypot-Webui
 * @author Jaime Acosta
 * Frontend application logic
 */

// ===== Configuration =====
const API_BASE = '/api';
const POLL_INTERVAL = 5000; // ms
let pollTimer = null;
let currentPage = 'dashboard';
let logSearchDebounceTimer = null;

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
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        if (err.name === 'TypeError' && err.message.includes('fetch')) {
            throw new Error('Unable to connect to the management API');
        }
        throw err;
    }
}

// ===== Status Management =====
async function refreshStatus() {
    try {
        const data = await apiFetch('/status');
        updateStatusUI(data);
    } catch (err) {
        updateStatusUI({ status: 'unknown', message: 'API unreachable' });
    }
}

function updateStatusUI(data) {
    const status = data.status || 'unknown';
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
    } else if (data.message) {
        subtitle.textContent = data.message;
    } else {
        subtitle.textContent = `Container: ${data.container_name || 'N/A'}`;
    }

    // Button states
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const btnRestart = document.getElementById('btnRestart');

    btnStart.disabled = status === 'running';
    btnStop.disabled = status !== 'running';
    btnRestart.disabled = status !== 'running';

    // Sidebar status
    const isRunning = status === 'running';
    sidebarDot.className = `status-dot-small ${isRunning ? 'running' : 'stopped'}`;
    sidebarText.textContent = isRunning ? 'Cowrie Running' : 'Cowrie Stopped';
    sidebarBadge.className = `status-badge-sidebar ${isRunning ? '' : 'stopped'}`;
}

// ===== Honeypot Control =====
async function controlHoneypot(action) {
    const btn = document.getElementById(`btn${action.charAt(0).toUpperCase() + action.slice(1)}`);
    const originalHTML = btn.innerHTML;

    try {
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> ${action}ing...`;

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

    try {
        await apiFetch('/config', {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        showToast('Configuration saved successfully', 'success');
        if (payload.auto_restart) {
            showToast('Honeypot is restarting...', 'info');
            setTimeout(refreshStatus, 4000);
        }
    } catch (err) {
        showToast(`Failed to save: ${err.message}`, 'error');
    }
}

// ===== LLM Settings =====
function selectProvider(provider) {
    document.querySelectorAll('.provider-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.provider === provider);
    });

    document.getElementById('openaiSettings').style.display = provider === 'openai' ? 'block' : 'none';
    document.getElementById('ollamaSettings').style.display = provider === 'ollama' ? 'block' : 'none';
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

    } catch (err) {
        // Use defaults
    }
}

async function saveSettings(event) {
    event.preventDefault();

    const selectedProvider = document.querySelector('.provider-card.selected')?.dataset.provider || 'openai';

    let openaiModel = document.getElementById('settOpenAIModel').value;
    if (openaiModel === 'custom') {
        openaiModel = document.getElementById('settOpenAICustomModel').value || 'gpt-4o-mini';
    }

    const payload = {
        llm_provider: selectedProvider,
        openai_api_key: document.getElementById('settApiKey').value,
        openai_host: document.getElementById('settOpenAIHost').value,
        openai_host_history: updateHistoryArray('openaiHostHistory', document.getElementById('settOpenAIHost').value),
        openai_model: openaiModel,
        ollama_host: document.getElementById('settOllamaHost').value,
        ollama_host_history: updateHistoryArray('ollamaHostHistory', document.getElementById('settOllamaHost').value),
        ollama_model: document.getElementById('settOllamaModel').value,
        llm_temperature: parseFloat(document.getElementById('settTemperature').value) || 0.7,
        llm_max_tokens: parseInt(document.getElementById('settMaxTokens').value) || 500,
        llm_debug: document.getElementById('settDebug').checked,
    };

    try {
        await apiFetch('/settings', {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        showToast('LLM settings saved successfully', 'success');
    } catch (err) {
        showToast(`Failed to save: ${err.message}`, 'error');
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
        
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function switchToManualOllama(currentValue) {
    const container = document.getElementById('ollamaModelContainer');
    container.innerHTML = `
        <input type="text" class="form-input mono" id="settOllamaModel" value="${currentValue}" placeholder="llama3">
    `;
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

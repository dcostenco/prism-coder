import { OMLX_SETUP_MODELS } from "../utils/omlxSetup.js";

export function localCodingPanelHTML(): string {
    return `<div class="s-tab-panel" id="spanel-local">
      <div class="setting-section">Local coding</div>
      <p class="setting-desc">Choose where coding drafts run. An explicit task choice overrides this preference. Tool routing and images keep their supported backend.</p>
      <form id="local-coding-form" onsubmit="saveLocalCoding(event)" style="display:grid;gap:14px;margin-top:18px">
        <label class="setting-label" for="local-coding-backend">Preferred coding backend</label>
        <select class="setting-select" id="local-coding-backend" style="width:100%;max-width:100%" disabled>
          <option value="auto">Auto — prefer configured oMLX</option><option value="omlx">oMLX</option><option value="ollama">Ollama</option>
        </select>
        <label class="setting-label" for="local-coding-source">oMLX connection</label>
        <select class="setting-select" id="local-coding-source" style="width:100%;max-width:100%" disabled>
          <option value="existing">Existing oMLX server</option><option value="managed">Prism-managed installation</option>
        </select>
        <label class="setting-label" for="local-coding-model">oMLX coding model (leave empty for the server default)</label>
        <input class="setting-select" id="local-coding-model" list="local-coding-models" maxlength="256" placeholder="Exact model ID advertised by oMLX" style="width:100%;max-width:100%;box-sizing:border-box" disabled>
        <datalist id="local-coding-models"></datalist>
        <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" id="local-coding-save" type="submit" disabled>Save coding preference</button><button class="skill-upload-btn" type="button" onclick="loadLocalCoding(false)">Check saved connection</button></div>
      </form>
      <p id="local-coding-saved" class="setting-desc" aria-live="polite"></p>
      <div id="local-coding-connection" class="setting-desc" role="status" style="margin:16px 0;padding:12px;border:1px solid var(--border-glass);border-radius:8px">Checking local coding setup…</div>
      <a id="local-coding-admin" target="_blank" rel="noopener noreferrer" style="display:none">Open oMLX settings</a>
      <div class="setting-section" style="margin-top:24px">Set up oMLX on this Mac</div>
      <p class="setting-desc">Use your existing server to avoid duplicate downloads. New setup installs the pinned Prism-compatible server in an isolated Python environment. Downloads are opt-in; npm installation never starts them.</p>
      <p class="setting-desc">Apple Silicon · macOS 15+ · Python 3.11–3.13 · 32 GiB unified memory · 40 GiB free disk. The standard install uses generic kernels; full Xcode builds can be faster.</p>
      <ul class="setting-desc" style="line-height:1.8;padding-left:20px">${OMLX_SETUP_MODELS.map(model => `<li><a href="https://huggingface.co/${model.repo}" target="_blank" rel="noopener noreferrer">${model.label}</a> — about ${model.approximateGB} GB</li>`).join("")}</ul>
      <p class="setting-desc">Review the model licenses before downloading. Managed setup uses port 8001, keeps a 10 GB cache limit, and leaves existing oMLX and Ollama processes running. Prism's oMLX path requires a 27B model ceiling from the task and plan, plus available memory.</p>
      <div id="local-coding-setup-state" role="status" class="setting-desc" style="margin:14px 0"></div>
      <progress id="local-coding-progress" aria-label="oMLX setup progress" style="display:none;width:100%"></progress>
      <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" type="button" id="local-coding-install" onclick="localCodingAction('install')" disabled>Install oMLX + recommended models</button><button class="skill-upload-btn" type="button" id="local-coding-start" onclick="localCodingAction('start')" disabled>Start managed oMLX</button></div>
      <p class="setting-desc" style="margin-top:12px">After starting, select <strong>Prism-managed installation</strong> above and save. Managed connection settings stay separate from your existing server. Drafts require host review and tests.</p>
      <p id="local-coding-error" role="alert" style="color:var(--accent-red);overflow-wrap:anywhere"></p>
    </div>`;
}

/** ES5 to match the dashboard's inline-script compatibility contract. */
export function localCodingScript(): string {
    return `
var localCodingLoaded = false;
var localCodingBusy = false;
var localCodingPoll;
var localCodingReadSequence = 0;
var localCodingStartingUntil = 0;
var localCodingActionError = '';
function localCodingRequest(path, body) {
    return fetch('/api/local-coding' + path, body === undefined ? {cache:'no-store'} : {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    }).then(function(response) { return response.json().then(function(data) {
        if (!response.ok || data.error) throw new Error(data.error || 'Local coding request failed.');
        return data;
    }); });
}
function loadLocalCoding(reset) {
    clearTimeout(localCodingPoll);
    var sequence = ++localCodingReadSequence;
    return localCodingRequest('').then(function(data) {
        if (sequence !== localCodingReadSequence) return data;
        var settings = data.settings;
        if (reset || !localCodingLoaded) {
            document.getElementById('local-coding-backend').value = settings.backend;
            document.getElementById('local-coding-source').value = settings.source;
            document.getElementById('local-coding-model').value = settings.model || '';
            localCodingLoaded = true;
        }
        ['backend','source','model','save'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = !data.canManage || localCodingBusy; });
        document.getElementById('local-coding-backend').disabled = data.preference.envOverride !== null || !data.canManage || localCodingBusy;
        var override = data.preference.envOverride;
        document.getElementById('local-coding-saved').textContent = 'Saved: ' + settings.backend + ' · ' + settings.source + (override ? ' · Environment override: ' + override : ' · Applies to new tasks without restarting');
        var connection = data.connection;
        var classifier = connection.models.indexOf(data.requiredClassifier) >= 0;
        document.getElementById('local-coding-connection').textContent = !connection.connected ? 'oMLX not connected. Start or configure the selected server.' :
            'oMLX connected · ' + (connection.model || 'choose a coding model') + ' · ' + (connection.control ? 'Prism control available' : 'Prism control unavailable') + ' · ' + (classifier ? 'classifier advertised' : 'required classifier not advertised');
        if (connection.error) document.getElementById('local-coding-connection').textContent += ' · ' + connection.error;
        var list = document.getElementById('local-coding-models'); list.textContent = '';
        connection.models.forEach(function(id) { var option = document.createElement('option'); option.value = id; list.appendChild(option); });
        var admin = document.getElementById('local-coding-admin');
        admin.style.display = connection.adminUrl ? 'inline' : 'none';
        if (connection.adminUrl) admin.href = connection.adminUrl;
        var state = data.managed, job = state.job, running = job && job.state === 'running';
        document.getElementById('local-coding-setup-state').textContent = (state.installed ? 'Server installed' : 'Server not installed') + ' · ' + state.models.filter(function(model) { return model.downloaded; }).length + '/' + state.models.length + ' models downloaded · ' + state.freeDiskGB + ' GiB free' + (job ? ' · ' + job.stage + ' (' + job.state + ')' : '') + (state.server.connected ? ' · Managed server connected' : '');
        document.getElementById('local-coding-progress').style.display = running ? 'block' : 'none';
        var install = document.getElementById('local-coding-install');
        install.disabled = !data.canManage || !state.supported || running || localCodingBusy;
        install.textContent = job && (job.state === 'failed' || job.state === 'interrupted') ? 'Retry / resume setup' : state.installed && state.models.every(function(model) { return model.downloaded; }) ? 'Verify installed setup' : 'Install oMLX + recommended models';
        document.getElementById('local-coding-start').disabled = !data.canManage || !state.installed || state.models.some(function(model) { return !model.downloaded; }) || running || localCodingBusy || state.server.connected;
        if (!state.supported) document.getElementById('local-coding-setup-state').textContent += ' · Installation requires Apple Silicon with macOS 15+';
        if (!data.canManage) document.getElementById('local-coding-error').textContent = 'Open the dashboard on this Mac to manage local setup.';
        else document.getElementById('local-coding-error').textContent = localCodingActionError || data.preferenceError || (job && job.error) || '';
        if (state.server.connected) localCodingStartingUntil = 0;
        if (running || localCodingBusy || Date.now() < localCodingStartingUntil) localCodingPoll = setTimeout(function() { loadLocalCoding(false); }, 4000);
        return data;
    }).catch(function(error) {
        if (sequence !== localCodingReadSequence) return;
        document.getElementById('local-coding-error').textContent = error.message;
        ['save','install','start'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = true; });
    });
}
function saveLocalCoding(event) {
    event.preventDefault();
    var model = document.getElementById('local-coding-model').value.trim();
    var settings = {backend:document.getElementById('local-coding-backend').value,source:document.getElementById('local-coding-source').value};
    if (model) settings.model = model;
    localCodingBusy = true;
    localCodingActionError = '';
    localCodingReadSequence++;
    document.getElementById('local-coding-error').textContent = '';
    document.getElementById('local-coding-save').disabled = true;
    return localCodingRequest('/preferences', settings).then(function() {
        localCodingBusy = false;
        return loadLocalCoding(true);
    }).catch(function(error) { localCodingBusy = false; document.getElementById('local-coding-error').textContent = error.message; document.getElementById('local-coding-save').disabled = false; });
}
function localCodingAction(action) {
    localCodingBusy = true;
    localCodingActionError = '';
    localCodingReadSequence++;
    document.getElementById('local-coding-error').textContent = '';
    document.getElementById('local-coding-setup-state').textContent = action === 'start' ? 'Starting managed oMLX. Waiting for the server connection…' : 'Checking prerequisites before setup…';
    document.getElementById('local-coding-progress').style.display = 'block';
    ['install','start'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = true; });
    return localCodingRequest('/' + action, {}).then(function() {
        localCodingBusy = false;
        if (action === 'start') localCodingStartingUntil = Date.now() + 90000;
        return loadLocalCoding(false);
    }).catch(function(error) { localCodingBusy = false; localCodingActionError = error.message; document.getElementById('local-coding-error').textContent = error.message; loadLocalCoding(false); });
}
`;
}

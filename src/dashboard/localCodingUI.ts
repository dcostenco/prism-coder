import { OMLX_SETUP_MODELS } from "../utils/omlxSetup.js";
import { localImagePanelHTML, localImageScript } from "./localImageUI.js";

export function localCodingPanelHTML(): string {
    return `<div class="s-tab-panel" id="spanel-local">
      <div class="setting-section">Local coding</div>
      <p class="setting-desc">Choose where coding drafts and local reviews run. Models are discovered from your servers. The same model can serve both roles. Explicit task choices override these preferences. Tool routing and images keep their supported backend.</p>
      <form id="local-coding-form" onsubmit="saveLocalCoding(event)" style="display:grid;gap:14px;margin-top:18px">
        <label class="setting-label" for="local-coding-backend">Preferred coding backend</label>
        <select class="setting-select" id="local-coding-backend" style="width:100%;max-width:100%" disabled>
          <option value="auto">Auto — prefer configured oMLX</option><option value="omlx">oMLX</option><option value="ollama">Ollama</option>
        </select>
        <label class="setting-label" for="local-coding-source">oMLX connection</label>
        <select class="setting-select" id="local-coding-source" style="width:100%;max-width:100%" disabled>
          <option value="existing">Existing oMLX server</option><option value="managed">Prism-managed installation</option>
        </select>
        ${["omlx", "ollama"].map(backend => `<fieldset style="min-width:0;border:1px solid var(--border-glass);border-radius:8px;padding:12px;display:grid;gap:10px"><legend class="setting-label">${backend === "omlx" ? "oMLX" : "Ollama"} models</legend>
          ${["coder", "reviewer"].map(role => `<label class="setting-label" for="local-coding-${backend}-${role}">${role === "coder" ? "Coder" : "Reviewer"}</label><select class="setting-select" id="local-coding-${backend}-${role}" style="width:100%;max-width:100%" onchange="renderLocalCodingMemory()" disabled></select><p class="setting-desc" id="local-coding-${backend}-${role}-memory" style="margin:0;overflow-wrap:anywhere"></p>`).join("")}
          <p class="setting-desc" id="local-coding-${backend}-discovery" style="margin:0;overflow-wrap:anywhere" role="status"></p>
        </fieldset>`).join("")}
        <p class="setting-desc" id="local-coding-memory" style="margin:0"></p>
        <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" id="local-coding-save" type="submit" disabled>Save coding preference</button><button class="skill-upload-btn" type="button" onclick="loadLocalCoding(false)">Check saved connection</button></div>
      </form>
      <p id="local-coding-saved" class="setting-desc" aria-live="polite"></p>
      <div id="local-coding-connection" class="setting-desc" role="status" style="margin:16px 0;padding:12px;border:1px solid var(--border-glass);border-radius:8px">Checking local coding setup…</div>
      <a id="local-coding-admin" target="_blank" rel="noopener noreferrer" style="display:none">Open oMLX settings</a>
      ${localImagePanelHTML()}
      <div class="setting-section" style="margin-top:24px">Set up oMLX on this Mac</div>
      <p class="setting-desc">Use your existing server to avoid duplicate downloads. New setup installs the pinned Prism-compatible server in an isolated Python environment. Downloads are opt-in; npm installation never starts them.</p>
      <p class="setting-desc">Apple Silicon · macOS 15+ · Python 3.11–3.13 · 32 GiB unified memory · 40 GiB free disk. The standard install uses generic kernels; full Xcode builds can be faster.</p>
      <ul class="setting-desc" style="line-height:1.8;padding-left:20px">${OMLX_SETUP_MODELS.map(model => `<li><a href="https://huggingface.co/${model.repo}" target="_blank" rel="noopener noreferrer">${model.label}</a> — about ${model.approximateGB} GB</li>`).join("")}</ul>
      <p class="setting-desc">This optional starter pack does not restrict your model choices above. Review the model licenses before downloading. Managed setup uses port 8001, keeps a 10 GB cache limit, and leaves existing oMLX and Ollama processes running. Prism's oMLX path requires a 27B model ceiling from the task and plan, plus available memory.</p>
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
var localCodingModels = {omlx:[],ollama:[]};
var localCodingDiscoveryErrors = {};
function localCodingGiB(bytes) { return (bytes / Math.pow(1024, 3)).toFixed(1) + ' GiB'; }
function renderLocalCodingMemory() {
    ['omlx','ollama'].forEach(function(backend) {
        ['coder','reviewer'].forEach(function(role) {
            var id = document.getElementById('local-coding-' + backend + '-' + role).value;
            var model = localCodingModels[backend].filter(function(item) { return item.id === id; })[0];
            var text = !id ? 'Uses the backend default. No role-specific model is saved.' : !model ? (localCodingDiscoveryErrors[backend] ? 'Inventory unavailable; model availability and memory are unknown.' : 'Saved model is unavailable. It will be refused rather than replaced.') :
                (model.weightBytes ? 'Reported weights: ' + localCodingGiB(model.weightBytes) : 'Weight size unknown') +
                (model.loadedBytes ? ' · Loaded memory: ' + localCodingGiB(model.loadedBytes) : model.loaded === true ? ' · Loaded; memory unknown' : model.loaded === false ? ' · Not loaded' : ' · Load status unknown') +
                (model.weightBytes ? ' · Cold-load RAM estimate: at least ' + localCodingGiB(Math.max(model.weightBytes * 1.5, model.weightBytes + 2 * Math.pow(1024,3))) : ' · RAM requirements unknown');
            document.getElementById('local-coding-' + backend + '-' + role + '-memory').textContent = text;
        });
    });
}
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
        }
        ['backend','source','save'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = !data.canManage || localCodingBusy; });
        document.getElementById('local-coding-backend').disabled = data.preference.envOverride !== null || !data.canManage || localCodingBusy;
        var override = data.preference.envOverride;
        document.getElementById('local-coding-saved').textContent = 'Saved: ' + settings.backend + ' · ' + settings.source + (override ? ' · Environment override: ' + override : ' · Applies to new tasks without restarting');
        var connection = data.connection;
        var classifier = connection.models.indexOf(data.requiredClassifier) >= 0;
        document.getElementById('local-coding-connection').textContent = !connection.connected ? 'oMLX not connected. Start or configure the selected server.' :
            'oMLX connected · ' + (connection.model || 'choose a coding model') + ' · ' + (connection.control ? 'Prism control available' : 'Prism control unavailable') + ' · ' + (classifier ? 'classifier advertised' : 'required classifier not advertised');
        if (connection.error) document.getElementById('local-coding-connection').textContent += ' · ' + connection.error;
        localCodingModels = data.discovered || {omlx:[],ollama:[]};
        localCodingDiscoveryErrors = data.discoveryErrors || {};
        // Older compatible servers may advertise IDs without memory metadata.
        if (!localCodingModels.omlx.length && connection.connected) localCodingModels.omlx = connection.models.map(function(id) { return {id:id}; });
        ['omlx','ollama'].forEach(function(backend) {
            ['coder','reviewer'].forEach(function(role) {
                var select = document.getElementById('local-coding-' + backend + '-' + role);
                var saved = settings.models && settings.models[backend] && settings.models[backend][role];
                if (!saved && backend === 'omlx' && role === 'coder') saved = settings.model;
                var value = reset || !localCodingLoaded ? saved || '' : select.value;
                select.textContent = '';
                var automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = 'Use backend default'; select.appendChild(automatic);
                localCodingModels[backend].forEach(function(model) { var option = document.createElement('option'); option.value = model.id; option.textContent = model.id; select.appendChild(option); });
                if (value && !localCodingModels[backend].some(function(model) { return model.id === value; })) {
                    var unavailable = document.createElement('option'); unavailable.value = value; unavailable.textContent = (localCodingDiscoveryErrors[backend] ? 'Availability unknown: ' : 'Unavailable: ') + value; select.appendChild(unavailable);
                }
                select.value = value;
                select.disabled = !data.canManage || localCodingBusy;
            });
            document.getElementById('local-coding-' + backend + '-discovery').textContent = data.discoveryErrors && data.discoveryErrors[backend] || localCodingModels[backend].length + ' models detected. Refresh checks inventory without loading models.';
        });
        localCodingLoaded = true;
        document.getElementById('local-coding-memory').textContent = 'Available RAM: ' + (data.availableMemoryBytes ? localCodingGiB(data.availableMemoryBytes) : 'unknown') + '. RAM estimates exclude workload-dependent peaks and do not guarantee a fit. Runtime admission checks still apply.';
        renderLocalCodingMemory();
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
    var settings = {backend:document.getElementById('local-coding-backend').value,source:document.getElementById('local-coding-source').value};
    settings.models = {};
    ['omlx','ollama'].forEach(function(backend) {
        settings.models[backend] = {};
        ['coder','reviewer'].forEach(function(role) {
            var model = document.getElementById('local-coding-' + backend + '-' + role).value;
            if (model) settings.models[backend][role] = model;
        });
    });
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
` + localImageScript();
}

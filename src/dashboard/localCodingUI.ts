import { OMLX_SETUP_MODELS, OMLX_SETUP_SOURCE_URL, OMLX_UPSTREAM_RELEASES_URL } from "../utils/omlxSetup.js";
import { localImagePanelHTML, localImageScript } from "./localImageUI.js";
const LOCAL_AI_RESULT_COPY = {
    reference: "Reference facts", observations: "AI observations",
    note: "AI output is not verified against the reference.", unavailable: "Reference information unavailable for this response.",
    initial: "Not tested in this dashboard session.", running: "Running a local diagnostic; the saved model may load…",
    passed: "Test passed · ", blocked: "Test blocked · ", failed: "Test failed · ", reason: " Reason: ", response: " Response: ",
};

export function localCodingPanelHTML(): string {
    return `<div class="s-tab-panel" id="spanel-local">
      <div class="setting-section">Local AI</div>
      <p class="setting-desc">Connect a server, choose models for each purpose, then test a saved choice. Diagnostic prompts and pictures stay local.</p>
      <section aria-labelledby="local-ai-connection-title" style="margin-top:20px">
      <h3 class="setting-section" id="local-ai-connection-title">1. Connection</h3>
      <label class="setting-label" for="local-coding-source">oMLX connection</label>
      <select class="setting-select" id="local-coding-source" onchange="clearLocalAiPreview()" style="width:100%;margin:8px 0" disabled><option value="existing">Existing oMLX server</option><option value="managed">Prism-managed installation</option></select>
      <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-upload-btn" id="local-ai-preview-button" type="button" onclick="previewLocalAiConnection()" disabled>Preview connection</button><button class="skill-save-btn" id="local-ai-activate" type="button" onclick="activateLocalAiConnection()" disabled>Use this server</button></div>
      <p class="setting-desc" id="local-ai-preview" aria-live="polite">Preview the effect on all oMLX purposes before switching.</p>
      <div id="local-coding-connection" class="setting-desc" role="status" style="margin:16px 0;padding:12px;border:1px solid var(--border-glass);border-radius:8px">Checking saved connection…</div>
      <a id="local-coding-admin" target="_blank" rel="noopener noreferrer" style="display:none">Open oMLX model manager</a>
      <details style="margin-top:16px"><summary class="setting-label">Install or update a Prism-managed server</summary>
      <p class="setting-desc">Optional isolated setup for Apple Silicon, macOS 15+, and Python 3.11–3.13. Install the server first, then add models. Installation does not change your active connection.</p>
      <p class="setting-desc"><a href="${OMLX_SETUP_SOURCE_URL}" target="_blank" rel="noopener noreferrer">Tested Prism-compatible source</a> · <a href="${OMLX_UPSTREAM_RELEASES_URL}" target="_blank" rel="noopener noreferrer">Latest upstream releases</a>. Upstream releases may not include Prism control and image routes. Updating Prism npm does not update an external server.</p>
      <p id="local-coding-setup-state" class="setting-desc" role="status"></p>
      <progress id="local-coding-progress" aria-label="oMLX setup progress" style="display:none;width:100%;margin:8px 0"></progress>
      <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" type="button" id="local-coding-install-server" onclick="localCodingAction('install-server')" disabled>Install / update server only</button><button class="skill-upload-btn" type="button" id="local-coding-start" onclick="localCodingAction('start')" disabled>Start managed server</button><button class="skill-upload-btn" type="button" id="local-coding-restart" onclick="confirmLocalAiRestart()" disabled>Restart managed server</button></div>
      <p class="setting-desc">A restart interrupts local inference and requires proven managed ownership and idle activity. An unproved exit blocks inference until operator recovery. External servers are left running.</p>
      </details></section>
      <section aria-labelledby="local-ai-models-title"><h3 class="setting-section" id="local-ai-models-title" style="margin-top:24px">2. Models</h3>
      <p class="setting-desc">Models are detected from your servers. The same model may serve coder and reviewer. Unavailable IDs stay saved; explicit task choices take precedence. Ollama uses its configured local connection.</p>
      <form id="local-coding-form" onsubmit="saveLocalCoding(event)" style="display:grid;gap:14px;margin-top:18px">
        <label class="setting-label" for="local-coding-backend">Preferred coding backend</label>
        <select class="setting-select" id="local-coding-backend" style="width:100%;max-width:100%" disabled>
          <option value="auto">Auto — prefer configured oMLX</option><option value="omlx">oMLX</option><option value="ollama">Ollama</option>
        </select>
        ${["omlx", "ollama"].map(backend => `<fieldset style="min-width:0;border:1px solid var(--border-glass);border-radius:8px;padding:12px;display:grid;gap:10px"><legend class="setting-label">${backend === "omlx" ? "oMLX" : "Ollama"} models</legend>
          ${["coder", "reviewer"].map(role => `<label class="setting-label" for="local-coding-${backend}-${role}">${role === "coder" ? "Coder" : "Reviewer"}</label><select class="setting-select" id="local-coding-${backend}-${role}" style="width:100%;max-width:100%" onchange="renderLocalCodingMemory()" disabled></select><p class="setting-desc" id="local-coding-${backend}-${role}-memory" style="margin:0;overflow-wrap:anywhere"></p>`).join("")}
          <p class="setting-desc" id="local-coding-${backend}-discovery" style="margin:0;overflow-wrap:anywhere" role="status"></p>
        </fieldset>`).join("")}
        <p class="setting-desc" id="local-coding-memory" style="margin:0"></p>
        <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" id="local-coding-save" type="submit" disabled>Save coding preference</button><button class="skill-upload-btn" type="button" onclick="loadLocalCoding(false)">Check saved connection</button></div>
      </form>
      <p id="local-coding-saved" class="setting-desc" aria-live="polite"></p>
      ${localImagePanelHTML()}
      <details style="margin-top:16px"><summary class="setting-label">Optional coding starter pack</summary>
      <p class="setting-desc">oMLX coding and review require the text safety classifier below. Image requests use the selected vision model for screening. The full pack needs at least 32 GiB unified memory and the disk space reported above.</p>
      <ul class="setting-desc" style="line-height:1.8;padding-left:20px">${OMLX_SETUP_MODELS.map(model => `<li><a href="https://huggingface.co/${model.repo}" target="_blank" rel="noopener noreferrer">${model.label}</a> — about ${model.approximateGB} GB</li>`).join("")}</ul>
      <p class="setting-desc">Review model licenses before downloading. This pack does not restrict your choices. Managed setup chooses an available port, limits cache to 10 GB, and preserves existing oMLX and Ollama processes.</p>
      <button class="skill-upload-btn" type="button" id="local-coding-install" onclick="localCodingAction('install')" disabled>Install oMLX + recommended models</button>
      </details></section>
      <section aria-labelledby="local-ai-test-title"><h3 class="setting-section" id="local-ai-test-title" style="margin-top:24px">3. Test</h3>
      <p class="setting-desc">Run a bounded request using a saved choice and your account entitlement. Tests may load models. Refreshing inventory never runs inference. A passing test proves execution, not accuracy or future RAM fit.</p>
      <label class="setting-label" for="local-ai-test-backend">Backend</label><select class="setting-select" id="local-ai-test-backend" onchange="clearLocalAiTestResult()" style="width:100%;margin:8px 0"><option value="omlx">oMLX</option><option value="ollama">Ollama</option></select>
      <label class="setting-label" for="local-ai-test-purpose">Purpose</label><select class="setting-select" id="local-ai-test-purpose" onchange="clearLocalAiTestResult()" style="width:100%;margin:8px 0"><option value="coder">Coder</option><option value="reviewer">Reviewer</option><option value="image">Image (oMLX only)</option></select>
      <button class="skill-save-btn" id="local-ai-test" type="button" onclick="testLocalAi()" disabled>Test saved model</button>
      <p id="local-ai-test-result" class="setting-desc" aria-live="polite">${LOCAL_AI_RESULT_COPY.initial}</p>
      <div id="local-ai-image-result" hidden aria-live="polite" style="margin-top:12px;padding:12px;border:1px solid var(--border-color);border-radius:8px;overflow-wrap:anywhere">
        <dl style="margin:0"><dt class="setting-label">${LOCAL_AI_RESULT_COPY.reference}</dt><dd id="local-ai-reference" class="setting-desc" style="margin:4px 0 12px"></dd>
        <dt class="setting-label">${LOCAL_AI_RESULT_COPY.observations}</dt><dd id="local-ai-observation" class="setting-desc" style="margin:4px 0;white-space:pre-wrap"></dd></dl>
        <p class="setting-desc" style="margin:8px 0 0">${LOCAL_AI_RESULT_COPY.note}</p>
      </div></section>
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
var localAiTestCopy = ${JSON.stringify(LOCAL_AI_RESULT_COPY)};
var localAiTestSequence = 0;
var localCodingModels = {omlx:[],ollama:[]};
var localCodingDiscoveryErrors = {};
var localCodingClassifier = '';
var localCodingSavedSource = 'existing';
var localAiPreview = null;
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
            if (backend === 'omlx' && id) {
                var classifier = localCodingModels.omlx.filter(function(item) { return item.id === localCodingClassifier; })[0];
                if (id === localCodingClassifier) text += ' · Shares the safety model; no duplicate weight allocation.';
                else if (model && model.weightBytes && classifier && classifier.weightBytes) text += ' · With safety dependency: at least ' + localCodingGiB(Math.max(model.weightBytes * 1.5, model.weightBytes + 2 * Math.pow(1024,3)) + Math.max(classifier.weightBytes * 1.5, classifier.weightBytes + 2 * Math.pow(1024,3))) + ' cold-load RAM; peak unknown.';
                else text += ' · Coding/review safety dependency RAM unknown.';
            }
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
        localCodingSavedSource = settings.source;
        if (reset || !localCodingLoaded) {
            document.getElementById('local-coding-backend').value = settings.backend;
            document.getElementById('local-coding-source').value = settings.source;
        }
        ['backend','source','save'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = !data.canManage || localCodingBusy; });
        document.getElementById('local-ai-preview-button').disabled = !data.canManage || localCodingBusy;
        document.getElementById('local-ai-test').disabled = !data.canManage || localCodingBusy;
        document.getElementById('local-coding-backend').disabled = data.preference.envOverride !== null || !data.canManage || localCodingBusy;
        var override = data.preference.envOverride;
        document.getElementById('local-coding-saved').textContent = 'Saved: ' + settings.backend + ' · ' + settings.source + (override ? ' · Environment override: ' + override : ' · Applies to new tasks without restarting');
        var connection = data.connection;
        var classifier = connection.models.indexOf(data.requiredClassifier) >= 0;
        document.getElementById('local-coding-connection').textContent = !connection.connected ? 'oMLX not connected. Start or configure the selected server.' :
            'oMLX connected · ' + (connection.model || 'choose a coding model') + ' · ' + (connection.control ? 'Prism control available' : 'Prism control unavailable') + ' · ' + (classifier ? 'classifier advertised' : 'required classifier not advertised');
        if (connection.error) document.getElementById('local-coding-connection').textContent += ' · ' + connection.error;
        localCodingModels = data.discovered || {omlx:[],ollama:[]};
        localCodingClassifier = data.requiredClassifier || '';
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
        document.getElementById('local-coding-memory').textContent = 'Available RAM: ' + (data.availableMemoryBytes ? localCodingGiB(data.availableMemoryBytes) : 'unknown') + '. Estimates are per request, not the sum of assigned roles. Coding/review also need their safety model; the same resident model is counted once. Workload peaks remain unknown. Fresh runtime admission checks still apply.';
        renderLocalCodingMemory();
        var admin = document.getElementById('local-coding-admin');
        admin.style.display = connection.adminUrl ? 'inline' : 'none';
        if (connection.adminUrl) admin.href = connection.adminUrl;
        var state = data.managed, job = state.job, running = job && job.state === 'running';
        document.getElementById('local-coding-setup-state').textContent = (state.installed ? 'Server installed' : 'Server not installed') + ' · ' + state.models.filter(function(model) { return model.downloaded; }).length + '/' + state.models.length + ' models downloaded · ' + state.freeDiskGB + ' GiB free' + (job ? ' · ' + job.stage + ' (' + job.state + ')' : '') + (state.server.connected ? ' · Managed server connected' : '');
        var runtime = state.runtime || {};
        document.getElementById('local-coding-setup-state').textContent += ' · Installed revision: ' + (runtime.installedCommit ? runtime.installedCommit.slice(0,12) : 'not installed') + ' · Running revision: ' + (runtime.runningCommit ? runtime.runningCommit.slice(0,12) : 'unproven') + (runtime.updatePending ? ' · Restart required to use the installed update' : '');
        document.getElementById('local-coding-progress').style.display = running ? 'block' : 'none';
        var install = document.getElementById('local-coding-install');
        install.disabled = !data.canManage || !state.supported || running || localCodingBusy;
        install.textContent = job && (job.state === 'failed' || job.state === 'interrupted') ? 'Retry / resume setup' : state.installed && state.models.every(function(model) { return model.downloaded; }) ? 'Verify installed setup' : 'Install oMLX + recommended models';
        document.getElementById('local-coding-install-server').disabled = !data.canManage || !state.supported || running || localCodingBusy;
        document.getElementById('local-coding-start').disabled = !data.canManage || !state.installed || running || localCodingBusy || state.server.connected;
        document.getElementById('local-coding-restart').disabled = !data.canManage || !state.installed || !state.server.owned || running || localCodingBusy;
        if (!state.supported) document.getElementById('local-coding-setup-state').textContent += ' · Installation requires Apple Silicon with macOS 15+';
        if (!data.canManage) document.getElementById('local-coding-error').textContent = 'Open the dashboard on this Mac to manage local setup.';
        else document.getElementById('local-coding-error').textContent = localCodingActionError || data.preferenceError || (job && job.error) || '';
        if (state.server.connected) localCodingStartingUntil = 0;
        if (running || localCodingBusy || Date.now() < localCodingStartingUntil) localCodingPoll = setTimeout(function() { loadLocalCoding(false); }, 4000);
        return data;
    }).catch(function(error) {
        if (sequence !== localCodingReadSequence) return;
        document.getElementById('local-coding-error').textContent = error.message;
        ['save','install','install-server','start','restart'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = true; });
        document.getElementById('local-ai-test').disabled = true;
        clearLocalAiPreview();
    });
}
function saveLocalCoding(event) {
    event.preventDefault();
    var settings = {backend:document.getElementById('local-coding-backend').value,source:localCodingSavedSource};
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
    return localCodingRequest('/model-preferences', settings).then(function() {
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
    ['install','install-server','start','restart'].forEach(function(name) { document.getElementById('local-coding-' + name).disabled = true; });
    return localCodingRequest('/' + action, {}).then(function() {
        localCodingBusy = false;
        if (action === 'start') localCodingStartingUntil = Date.now() + 90000;
        return loadLocalCoding(false);
    }).catch(function(error) { localCodingBusy = false; localCodingActionError = error.message; document.getElementById('local-coding-error').textContent = error.message; loadLocalCoding(false); });
}
function clearLocalAiPreview() {
    localAiPreview = null;
    document.getElementById('local-ai-activate').disabled = true;
    document.getElementById('local-ai-preview').textContent = 'Preview the effect on all oMLX purposes before switching.';
}
function previewLocalAiConnection() {
    clearLocalAiPreview();
    var source = document.getElementById('local-coding-source').value;
    document.getElementById('local-ai-preview').textContent = 'Checking connection and saved assignments…';
    return localCodingRequest('/connection-preview?source=' + encodeURIComponent(source)).then(function(data) {
        if (document.getElementById('local-coding-source').value !== source) return;
        localAiPreview = data;
        var effects = data.assignments.map(function(item) { return item.purpose + ': ' + (item.model || 'no saved model') + (item.model ? item.available ? ' (available)' : ' (unavailable; kept saved)' : ''); }).join(' · ');
        var effective = data.effective || {};
        document.getElementById('local-ai-preview').textContent = data.sharedScope + ' ' + effects + ' · Effective coding backend: ' + (effective.codingBackend || 'unknown') + (effective.backendOverride ? ' (environment override)' : '') + ' · Image backend: ' + (effective.imageBackend || 'legacy') + (effective.existingEndpointOverride || effective.existingAuthOverride ? ' · Existing connection uses environment overrides; they are preserved.' : '') + (data.canActivate ? ' · Ready to use.' : ' · Not ready; check the server control API and managed ownership.');
        document.getElementById('local-ai-activate').disabled = !data.canActivate;
    }).catch(function(error) { document.getElementById('local-ai-preview').textContent = error.message; });
}
function activateLocalAiConnection() {
    if (!localAiPreview || !localAiPreview.canActivate) return;
    var preview = localAiPreview;
    document.getElementById('local-ai-activate').disabled = true;
    return localCodingRequest('/activate-connection', {source:preview.source,revision:preview.revision}).then(function() {
        clearLocalAiPreview();
        localCodingLoaded = false;
        return Promise.all([loadLocalCoding(true),loadLocalImages(true)]);
    }).catch(function(error) { clearLocalAiPreview(); document.getElementById('local-ai-preview').textContent = error.message; });
}
function confirmLocalAiRestart() {
    if (window.confirm('Restart the proven Prism-managed server? Local inference will be interrupted. A failed retirement may require manual recovery.')) return localCodingAction('restart');
}
function clearLocalAiImageResult() {
    document.getElementById('local-ai-image-result').hidden = true;
    document.getElementById('local-ai-reference').textContent = '';
    document.getElementById('local-ai-observation').textContent = '';
}
function clearLocalAiTestResult() {
    localAiTestSequence++;
    clearLocalAiImageResult();
    document.getElementById('local-ai-test-result').textContent = localAiTestCopy.initial;
}
function testLocalAi() {
    var button = document.getElementById('local-ai-test'), result = document.getElementById('local-ai-test-result');
    if (button.disabled) return Promise.resolve();
    clearLocalAiTestResult();
    var sequence = localAiTestSequence, backend = document.getElementById('local-ai-test-backend').value,
        purpose = document.getElementById('local-ai-test-purpose').value;
    button.disabled = true;
    result.textContent = localAiTestCopy.running;
    return localCodingRequest('/test', {backend:backend,purpose:purpose}).then(function(data) {
        if (sequence !== localAiTestSequence) return;
        result.textContent = (data.status === 'passed' ? localAiTestCopy.passed : localAiTestCopy.blocked) + data.message
            + (data.status !== 'passed' && typeof data.reason === 'string' ? localAiTestCopy.reason + data.reason + '.' : '');
        if (data.status === 'passed' && typeof data.output === 'string' && purpose === 'image') {
            var reference = data.reference;
            document.getElementById('local-ai-reference').textContent = reference && reference.source === 'builtin-diagnostic'
                && typeof reference.description === 'string' && typeof reference.width === 'number' && typeof reference.height === 'number'
                && reference.format === 'PNG' && typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256)
                ? reference.description + ' · ' + reference.width + '×' + reference.height + ' ' + reference.format : localAiTestCopy.unavailable;
            document.getElementById('local-ai-observation').textContent = data.output;
            document.getElementById('local-ai-image-result').hidden = false;
        } else if (data.output) result.textContent += localAiTestCopy.response + data.output;
    }).catch(function(error) { if (sequence === localAiTestSequence) { clearLocalAiImageResult(); result.textContent = localAiTestCopy.failed + error.message; } }).then(function() { button.disabled = false; });
}
` + localImageScript();
}

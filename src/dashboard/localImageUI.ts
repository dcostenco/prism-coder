const IMAGE_UPGRADE_GUIDE = "https://github.com/dcostenco/prism-coder/blob/main/docs/omlx.md#upgrade-an-existing-omlx-server";
const IMAGE_INPUT_TEXT = Object.freeze({
    not_selected: "Select an oMLX image model to check server compatibility.",
    checking: "Checking the selected model's server input contract…",
    available: "Server input contract available. Each request repeats admission checks; this does not certify image accuracy or RAM fit.",
    update_required: "Server update required for controlled images. Upgrade oMLX separately; restarting Prism alone does not update the server.",
    not_enabled: "Image input is not enabled for this model. Check the model family and resolved context settings on the server.",
    unknown: "Image-input compatibility unknown. Check the server connection and refresh; an upgrade requirement has not been established.",
    authentication: "Image-input compatibility unknown: check oMLX authentication, then refresh.",
    guide: "Existing-server upgrade guide (preserve models and settings)",
});

export function localImagePanelHTML(): string {
    return `<div class="setting-section" style="margin-top:24px">Image model</div>
      <p class="setting-desc" id="local-image-boundary">Save a separate model for image tasks. oMLX requests check the server image-input capability before inference. Selected Ollama image execution is unavailable. Leave the backend unset to keep existing image routing. Advertised vision support is not a passed image test.</p>
      <form id="local-image-form" onsubmit="saveLocalImages(event)" style="display:grid;gap:12px;margin-top:14px">
        <label class="setting-label" for="local-image-backend">Preferred image backend</label>
        <select class="setting-select" id="local-image-backend" style="width:100%;max-width:100%" disabled><option value="">Not selected</option><option value="omlx">oMLX</option><option value="ollama">Ollama</option></select>
        ${["omlx", "ollama"].map(backend => `<label class="setting-label" for="local-image-${backend}-model">${backend === "omlx" ? "oMLX" : "Ollama"} image model</label>
        <select class="setting-select" id="local-image-${backend}-model" onchange="imageSelectionChanged('${backend}')" style="width:100%;max-width:100%" disabled></select>
        <p class="setting-desc" id="local-image-${backend}-metadata" style="margin:0;overflow-wrap:anywhere" role="status"></p>`).join("")}
        <p class="setting-desc" id="local-image-omlx-input" role="status" style="margin:0;overflow-wrap:anywhere"></p>
        <a id="local-image-upgrade-guide" href="${IMAGE_UPGRADE_GUIDE}" target="_blank" rel="noopener noreferrer" style="display:none">${IMAGE_INPUT_TEXT.guide}</a>
        <p class="setting-desc" id="local-image-memory" style="margin:0"></p>
        <div class="skill-actions" style="flex-wrap:wrap"><button class="skill-save-btn" id="local-image-save" type="submit" disabled>Save image preference</button><button class="skill-upload-btn" id="local-image-refresh" type="button" onclick="loadLocalImages(false)">Refresh image models</button></div>
      </form>
      <p class="setting-desc" id="local-image-saved" aria-live="polite"></p>
      <p id="local-image-error" role="alert" style="color:var(--accent-red);overflow-wrap:anywhere"></p>`;
}

/** Kept independent of the coding request, including its busy/error state. ES5. */
export function localImageScript(): string {
    return `
var localImageLoaded = false;
var localImageBusy = false;
var localImageRefreshing = false;
var localImageSequence = 0;
var localImageCanManage = false;
var localImageModels = {omlx:[],ollama:[]};
var localImageErrors = {};
var localImageOmlxInput = null;
var localImageInputText = ${JSON.stringify(IMAGE_INPUT_TEXT)};
function renderLocalImageInput() {
    var id = document.getElementById('local-image-omlx-model').value;
    var input = localImageOmlxInput;
    var state = !id ? 'not_selected' : localImageRefreshing ? 'checking' : input && input.model === id ? input.state : 'unknown';
    var text = input && input.model === id && input.reason === 'omlx_auth_failed' && state === 'unknown' ? localImageInputText.authentication : localImageInputText[state] || localImageInputText.unknown;
    document.getElementById('local-image-omlx-input').textContent = text;
    document.getElementById('local-image-upgrade-guide').style.display = state === 'update_required' ? 'inline' : 'none';
}
function imageFieldsDisabled() {
    ['backend','omlx-model','ollama-model'].forEach(function(name) { document.getElementById('local-image-' + name).disabled = !localImageLoaded || !localImageCanManage || localImageBusy; });
    document.getElementById('local-image-save').disabled = !localImageLoaded || !localImageCanManage || localImageBusy || localImageRefreshing;
    document.getElementById('local-image-refresh').disabled = localImageBusy;
}
function renderLocalImageMetadata() {
    ['omlx','ollama'].forEach(function(backend) {
        var id = document.getElementById('local-image-' + backend + '-model').value;
        var model = localImageModels[backend].filter(function(item) { return item.id === id; })[0];
        var text = !id ? 'No image model selected. No coding model is inherited.' : !model ? (localImageErrors[backend] ? 'Inventory unavailable; saved model availability is unknown.' : 'Selected model is unavailable in the current inventory.') :
            'Installed · Advertised vision: ' + model.capability.vision + ' (' + (model.capability.source === 'omlx.engine_type' ? 'oMLX engine metadata' : model.capability.source === 'ollama.show.capabilities' ? 'Ollama exact model metadata' : 'metadata unavailable or not inspected') + ')' +
            (model.weightBytes ? ' · Weights: ' + localCodingGiB(model.weightBytes) : ' · Weight size unknown') +
            (model.loadedBytes ? ' · Loaded memory: ' + localCodingGiB(model.loadedBytes) : model.loaded === true ? ' · Loaded; memory unknown' : model.loaded === false ? ' · Not loaded' : ' · Load status unknown') +
            (model.residentEstimateBytes ? ' · Server resident estimate: ' + localCodingGiB(model.residentEstimateBytes) : '');
        document.getElementById('local-image-' + backend + '-metadata').textContent = text + ' Image peak RAM unknown; execution requires a compatible server and current resource checks.' + (localImageErrors[backend] ? ' ' + localImageErrors[backend] : '');
    });
}
function imageSelectionChanged(backend) {
    renderLocalImageMetadata();
    return loadLocalImages(false);
}
function loadLocalImages(reset) {
    if (localImageBusy) return Promise.resolve();
    var sequence = ++localImageSequence;
    localImageRefreshing = true;
    localImageOmlxInput = null;
    renderLocalImageInput();
    imageFieldsDisabled();
    document.getElementById('local-image-error').textContent = '';
    var id = localImageLoaded ? document.getElementById('local-image-ollama-model').value : '';
    var omlxId = localImageLoaded ? document.getElementById('local-image-omlx-model').value : '';
    return localCodingRequest('/image-models' + (localImageLoaded && !reset ? '?ollamaModel=' + encodeURIComponent(id) + '&omlxModel=' + encodeURIComponent(omlxId) : '')).then(function(data) {
        if (sequence !== localImageSequence) return;
        var settings = data.settings;
        if (reset || !localImageLoaded) document.getElementById('local-image-backend').value = settings.backend || '';
        localImageModels = data.discovered;
        localImageErrors = data.discoveryErrors;
        localImageOmlxInput = data.omlxInput || null;
        ['omlx','ollama'].forEach(function(backend) {
            var select = document.getElementById('local-image-' + backend + '-model');
            var saved = settings.models && settings.models[backend] || '';
            var value = reset || !localImageLoaded ? saved : select.value;
            select.textContent = '';
            var empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Not selected'; select.appendChild(empty);
            localImageModels[backend].forEach(function(model) { var option = document.createElement('option'); option.value = model.id; option.textContent = model.id + ' · vision ' + model.capability.vision; select.appendChild(option); });
            if (value && !localImageModels[backend].some(function(model) { return model.id === value; })) {
                var missing = document.createElement('option'); missing.value = value; missing.textContent = (localImageErrors[backend] ? 'Availability unknown: ' : 'Unavailable: ') + value; select.appendChild(missing);
            }
            select.value = value;
        });
        localImageLoaded = true;
        localImageCanManage = data.canManage;
        document.getElementById('local-image-memory').textContent = 'Available RAM: ' + (data.availableMemoryBytes ? localCodingGiB(data.availableMemoryBytes) : 'unknown') + '. Metadata is advisory; image peak RAM is unknown. Refresh never loads, downloads or unloads a model.';
        document.getElementById('local-image-saved').textContent = 'Saved image backend: ' + (settings.backend || 'not selected') + ' · oMLX checks compatibility on each request; saving does not load a model.';
        if (!data.canManage) document.getElementById('local-image-error').textContent = 'Open this dashboard on this Mac to change image preferences.';
        renderLocalImageMetadata();
    }).catch(function(error) {
        if (sequence === localImageSequence) document.getElementById('local-image-error').textContent = error.message;
    }).then(function() {
        if (sequence === localImageSequence) { localImageRefreshing = false; imageFieldsDisabled(); renderLocalImageInput(); }
    });
}
function saveLocalImages(event) {
    event.preventDefault();
    if (!localImageLoaded || !localImageCanManage || localImageBusy || localImageRefreshing) return Promise.resolve();
    var settings = {}, models = {};
    var backend = document.getElementById('local-image-backend').value;
    if (backend) settings.backend = backend;
    ['omlx','ollama'].forEach(function(name) { var value = document.getElementById('local-image-' + name + '-model').value; if (value) models[name] = value; });
    if (Object.keys(models).length) settings.models = models;
    localImageBusy = true;
    localImageSequence++;
    imageFieldsDisabled();
    return localCodingRequest('/image-preferences', settings).then(function() {
        localImageBusy = false;
        return loadLocalImages(true);
    }).catch(function(error) {
        localImageBusy = false;
        document.getElementById('local-image-error').textContent = error.message;
        imageFieldsDisabled();
    });
}
`;
}

const $ = (s) => document.querySelector(s);
const state = { url: '', info: null, mode: 'video', height: 'best', vfmt: 'mp4', afmt: 'mp3', abr: '0' };

const clean = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fmtTime = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0');
};
const fmtSpeed = (b) => (b ? (b / 1048576).toFixed(1) + ' MB/s' : '');
const fmtEta = (s) => (s ? (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`) + ' left' : '');

// ---------- option chips ----------
function chips(el, items, key, after) {
  el.innerHTML = '';
  for (const [value, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state[key] === value ? ' on' : '');
    b.textContent = label;
    b.onclick = () => { state[key] = value; chips(el, items, key, after); after?.(); };
    el.append(b);
  }
}

function renderOptions() {
  const audio = state.mode === 'audio';
  const hs = state.info.heights;
  $('#video-opts').hidden = audio;
  $('#audio-opts').hidden = !audio;
  chips($('#mode'), [['video', 'Video'], ['audio', 'Audio only']], 'mode', renderOptions);
  chips($('#quality'), [['best', hs.length ? `Best · ${hs[0]}p` : 'Best'], ...hs.map((h) => [String(h), `${h}p`])], 'height');
  chips($('#vfmt'), [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']], 'vfmt');
  chips($('#afmt'), [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'Opus'], ['flac', 'FLAC'], ['wav', 'WAV']], 'afmt', renderOptions);
  chips($('#abr'), [['0', 'Best'], ['320K', '320 kbps'], ['192K', '192 kbps'], ['128K', '128 kbps']], 'abr');
  $('#abr-row').hidden = ['flac', 'wav'].includes(state.afmt);
}

// ---------- fetch ----------
function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function fetchInfo() {
  let url = $('#url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const btn = $('#fetch');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  showError('');
  try {
    state.info = await api.info(url);
    state.url = url;
    state.height = 'best';
    const { title, uploader, duration, thumbnail, site } = state.info;
    $('#title').textContent = title || 'Untitled';
    $('#sub').textContent = [site, uploader, fmtTime(duration)].filter(Boolean).join(' · ');
    $('#thumb').src = thumbnail || '';
    $('#thumb').hidden = !thumbnail;
    $('#panel').hidden = false;
    renderOptions();
  } catch (e) {
    $('#panel').hidden = true;
    showError(clean(e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch';
  }
}

// ---------- downloads ----------
function addJob(id, info, tag) {
  const el = document.createElement('div');
  el.className = 'job';
  el.id = 'job-' + id;
  el.dataset.state = 'downloading';
  el.innerHTML = `<img alt="" hidden>
    <div class="meta">
      <div class="top"><div class="t"></div><span class="tag"></span></div>
      <div class="s">Starting…</div>
      <div class="bar"><i></i></div>
    </div>
    <div class="act"><button class="ghost" data-act="cancel">Cancel</button></div>`;
  el.querySelector('.t').textContent = info.title || 'Untitled';
  el.querySelector('.tag').textContent = tag;
  const img = el.querySelector('img');
  if (info.thumbnail) { img.src = info.thumbnail; img.hidden = false; img.onerror = () => (img.hidden = true); }
  $('#jobs').prepend(el);
}

async function download() {
  if (!state.info) return;
  const { mode, height, vfmt, afmt, abr, url } = state;
  const tag = mode === 'audio'
    ? afmt.toUpperCase()
    : `${height === 'best' ? 'Best' : height + 'p'} ${vfmt.toUpperCase()}`;
  try {
    const id = await api.start({ url, mode, height, vfmt, afmt, abr });
    addJob(id, state.info, tag);
  } catch (e) {
    showError(clean(e));
  }
}

api.onProgress((d) => {
  const el = $('#job-' + d.id);
  if (!el) return;
  const s = el.querySelector('.s'), bar = el.querySelector('i'), act = el.querySelector('.act');
  el.dataset.state = d.status;
  if (d.status === 'downloading') {
    bar.style.width = d.pct.toFixed(1) + '%';
    s.textContent = [d.part > 1 ? 'Downloading audio track' : 'Downloading', Math.round(d.pct) + '%', fmtSpeed(d.speed), fmtEta(d.eta)].filter(Boolean).join(' · ');
  } else if (d.status === 'processing') {
    bar.style.width = '100%';
    s.textContent = 'Processing…';
  } else if (d.status === 'done') {
    bar.style.width = '100%';
    s.textContent = 'Saved';
    el.dataset.file = d.file || '';
    act.innerHTML = '<button class="ghost" data-act="reveal">Show in folder</button>';
  } else {
    s.textContent = d.status === 'cancelled' ? 'Cancelled' : d.message;
    act.innerHTML = '';
  }
});

$('#jobs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const job = b.closest('.job');
  if (b.dataset.act === 'cancel') api.cancel(+job.id.slice(4));
  else api.reveal(job.dataset.file || '');
});

// ---------- engine status ----------
function renderEngine(e) {
  const pill = $('#engine');
  pill.dataset.state = e.state;
  pill.title = e.error || '';
  pill.textContent =
    e.state === 'ready' ? `Engine ${e.version}`
    : e.state === 'error' ? 'Engine offline'
    : e.pct ? `Setting up engine… ${e.pct}%` : 'Setting up engine…';
}

// ---------- init ----------
$('#thumb').onerror = () => ($('#thumb').hidden = true);
$('#fetch').onclick = fetchInfo;
$('#download').onclick = download;
$('#pick').onclick = async () => ($('#dir').textContent = await api.chooseDir());
$('#url').addEventListener('keydown', (e) => e.key === 'Enter' && fetchInfo());
$('#url').addEventListener('paste', () => setTimeout(fetchInfo, 60));
api.getDir().then((d) => ($('#dir').textContent = d));
api.engine().then(renderEngine);
api.onEngine(renderEngine);

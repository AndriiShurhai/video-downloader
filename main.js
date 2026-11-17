const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net } = require('electron');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

const ASSETS = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' };
const ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const FFMPEG = (require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked');

let win, ytdlp, enginePromise;
let settings = {};
let engine = { state: 'setup', pct: 0, version: '', error: '' };
let nextId = 1;
const jobs = new Map();

const emit = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  if (!settings.dir || !fs.existsSync(settings.dir)) settings.dir = app.getPath('downloads');
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings));
}

// ---------- yt-dlp engine ----------
const lastError = (s) =>
  ((s || '').match(/ERROR:.*$/gm) || []).pop()?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');

const run = (args) =>
  new Promise((resolve, reject) =>
    execFile(ytdlp, args, { env: ENV, maxBuffer: 1 << 28, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(lastError(stderr) || err.message)) : resolve(stdout)
    )
  );

function setEngine(patch) {
  engine = { ...engine, ...patch };
  emit('engine', engine);
}

async function setupEngine() {
  ytdlp = path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  fs.mkdirSync(path.dirname(ytdlp), { recursive: true });
  setEngine({ state: 'setup', pct: 0, error: '' });
  try {
    if (!fs.existsSync(ytdlp)) {
      const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSETS[process.platform]}`);
      if (!res.ok) throw new Error(`Engine download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const body = Readable.fromWeb(res.body);
      let got = 0;
      body.on('data', (c) => {
        got += c.length;
        const pct = total ? Math.round((got / total) * 100) : 0;
        if (pct !== engine.pct) setEngine({ pct });
      });
      await pipeline(body, fs.createWriteStream(ytdlp + '.part'));
      fs.renameSync(ytdlp + '.part', ytdlp);
      fs.chmodSync(ytdlp, 0o755);
    }
    setEngine({ state: 'ready', version: (await run(['--version'])).trim() });
  } catch (e) {
    const error = e.message === 'fetch failed' ? 'No internet connection' : e.message;
    setEngine({ state: 'error', error });
    throw new Error(error);
  }
}

const engineReady = () =>
  (enginePromise ||= setupEngine().catch((e) => {
    enginePromise = null;
    throw e;
  }));

// ---------- download args ----------
const pick = (v, list, d) => (list.includes(v) ? v : d);
const checkUrl = (u) => {
  if (!/^https?:\/\/\S+$/i.test(u || '')) throw new Error('That does not look like a link');
  return u;
};

function buildArgs(o, dir) {
  const a = [
    '--no-playlist', '--newline', '--no-warnings', '--windows-filenames',
    '--trim-filenames', '150', '-P', dir, '-o', '%(title)s.%(ext)s',
    '--progress-template',
    'download:PRG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:DONE|%(filepath)s', '--no-quiet', '--no-simulate',
  ];
  if (FFMPEG) a.push('--ffmpeg-location', FFMPEG);

  if (o.mode === 'audio') {
    const fmt = pick(o.afmt, ['mp3', 'm4a', 'opus', 'flac', 'wav'], 'mp3');
    a.push('-f', 'ba/b', '-x', '--audio-format', fmt,
      '--audio-quality', pick(o.abr, ['0', '320K', '192K', '128K'], '0'), '--embed-metadata');
    if (['mp3', 'm4a'].includes(fmt)) a.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    const fmt = pick(o.vfmt, ['mp4', 'mkv', 'webm'], 'mp4');
    const res = /^\d+$/.test(o.height) ? `res:${o.height}` : 'res';
    // mp4: prefer h264/aac (plays everywhere) at the chosen resolution, falls back to best codec above 1080p
    const sort = fmt === 'mp4' ? `${res},fps,vcodec:h264,acodec:aac` : res;
    const sel = fmt === 'webm' ? 'bv*[ext=webm]+ba[ext=webm]/bv*+ba/b' : 'bv*+ba/b';
    a.push('-f', sel, '-S', sort, '--merge-output-format', fmt);
    if (fmt !== 'webm') a.push('--remux-video', fmt);
  }
  a.push('--', checkUrl(o.url));
  return a;
}

// ---------- IPC ----------
ipcMain.handle('engine', () => engine);
ipcMain.handle('get-dir', () => settings.dir);

ipcMain.handle('choose-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.dir });
  if (!r.canceled && r.filePaths[0]) {
    settings.dir = r.filePaths[0];
    saveSettings();
  }
  return settings.dir;
});

ipcMain.handle('info', async (_, url) => {
  checkUrl(url);
  await engineReady();
  const j = JSON.parse(await run(['-J', '--no-playlist', '--no-warnings', '--', url]));
  const heights = [...new Set((j.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
    .map((f) => f.height))].sort((x, y) => y - x);
  return {
    title: j.title,
    uploader: j.uploader || j.channel || '',
    duration: j.duration,
    thumbnail: j.thumbnail,
    site: j.extractor_key,
    heights,
  };
});

ipcMain.handle('start', async (_, o) => {
  await engineReady();
  const args = buildArgs(o, settings.dir);
  const id = nextId++;
  const child = spawn(ytdlp, args, { env: ENV, windowsHide: true });
  jobs.set(id, child);

  const send = (d) => emit('progress', { id, ...d });
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  let buf = '', err = '', file = '', part = 0;

  const onLine = (line) => {
    if (line.startsWith('PRG|')) {
      const [, got, total, est, speed, eta] = line.split('|');
      const t = num(total) || num(est);
      send({ status: 'downloading', part, pct: t ? Math.min(100, (num(got) / t) * 100) : 0, speed: num(speed), eta: Math.round(num(eta)) });
    } else if (line.startsWith('DONE|')) {
      file = line.slice(5).trim();
    } else if (line.startsWith('[download] Destination:')) {
      part++;
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer|Metadata|ThumbnailsConvertor|EmbedThumbnail|Fixup\w*)\]/.test(line)) {
      send({ status: 'processing' });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => { jobs.delete(id); send({ status: 'error', message: e.message }); });
  child.on('close', (code) => {
    jobs.delete(id);
    if (child.cancelled) send({ status: 'cancelled' });
    else if (code === 0) send({ status: 'done', file });
    else send({ status: 'error', message: lastError(err) || 'Download failed' });
  });
  return id;
});

ipcMain.on('cancel', (_, id) => {
  const j = jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(j.pid), '/T', '/F'], { windowsHide: true });
  else j.kill('SIGTERM');
});

ipcMain.on('reveal', (_, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(settings.dir);
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 780, minWidth: 760, minHeight: 600,
    backgroundColor: '#0a0a12', autoHideMenuBar: true, title: 'Grabber',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  loadSettings();
  // macOS needs an Edit menu or Cmd+C / Cmd+V stop working in text fields
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null
  );
  createWindow();
  // set up the engine, then self-update it in the background (sites break it often)
  engineReady().then(() => run(['-U']).catch(() => {})).catch(() => {});
});

app.on('before-quit', () => jobs.forEach((j) => j.kill()));
app.on('window-all-closed', () => app.quit());

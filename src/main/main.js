const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ytdlp = require('./ytdlp');
const updater = require('./updater');

let mainWindow = null;

// ---------------------------------------------------------------- settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = () => ({
    outDir: path.join(app.getPath('videos'), 'Videos Downloader'),
    mode: 'video',
    quality: 'best',
    browser: 'none',
    subfolder: true,
    number: true,
    subs: true,
    subLangs: 'en, pt',
    autoSubs: false,
});

function loadSettings() {
    try {
        return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
    } catch {
        return defaultSettings();
    }
}

// Write to a temp file and rename, so a read never sees a half-written file.
function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
}

function saveSettings(s) {
    writeAtomic(settingsFile(), JSON.stringify(s, null, 2));
}

// The download queue is kept in a file so it survives closing the app.
const queueFile = () => path.join(app.getPath('userData'), 'queue.json');

// ------------------------------------------------------------------ window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 800,
        minWidth: 820,
        minHeight: 560,
        show: false,
        backgroundColor: '#0b0c0f',
        frame: false,
        icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Frameless windows can repaint blank after minimize/restore; nudge a repaint.
    mainWindow.on('restore', () => {
        const [w, h] = mainWindow.getSize();
        mainWindow.setSize(w, h + 1);
        mainWindow.setSize(w, h);
    });
    mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

    mainWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Links (e.g. a video title) open in the real browser, never inside the app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('close', (e) => {
        if (!ytdlp.isBusy()) return;
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ['Keep downloading', 'Quit'],
            defaultId: 0,
            cancelId: 0,
            title: 'Videos Downloader',
            message: 'A download is still running. Quit anyway?',
        });
        if (choice === 0) e.preventDefault();
        else ytdlp.cancel();
    });
}

// --------------------------------------------------------------------- IPC
function registerIpc() {
    ipcMain.handle('window:minimize', () => mainWindow?.minimize());
    ipcMain.handle('window:maximize', () => {
        if (!mainWindow) return;
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    });
    ipcMain.handle('window:close', () => mainWindow?.close());

    ipcMain.handle('settings:get', () => loadSettings());
    ipcMain.handle('settings:set', (_e, patch) => {
        const next = { ...loadSettings(), ...patch };
        saveSettings(next);
        return next;
    });

    ipcMain.handle('queue:load', () => {
        try { return JSON.parse(fs.readFileSync(queueFile(), 'utf8')); } catch { return []; }
    });
    ipcMain.handle('queue:save', (_e, groups) => writeAtomic(queueFile(), JSON.stringify(groups)));

    ipcMain.handle('folder:pick', async (_e, current) => {
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose where to save downloads',
            defaultPath: current,
            properties: ['openDirectory', 'createDirectory'],
        });
        return res.canceled ? null : res.filePaths[0];
    });
    ipcMain.handle('folder:open', async (_e, dir) => {
        fs.mkdirSync(dir, { recursive: true });
        return shell.openPath(dir);
    });
    ipcMain.handle('link:open', (_e, url) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
    });

    ipcMain.handle('tools:status', () => ytdlp.toolStatus());
    ipcMain.handle('playlist:load', (_e, { url, browser }) => ytdlp.loadPlaylist(url, { browser }));
    // The window works through its queue one item at a time.
    ipcMain.handle('download:item', (_e, { item, options }) => ytdlp.downloadItem(item, options, (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:event', event);
    }));
    ipcMain.handle('download:cancel', () => ytdlp.cancel());
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    updater.init(() => mainWindow);
    if (app.isPackaged) ytdlp.selfUpdate();
});

app.on('window-all-closed', () => app.quit());

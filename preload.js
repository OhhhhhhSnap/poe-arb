'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poeArb', {
  getData:      ()        => ipcRenderer.invoke('get-data'),
  refresh:      ()        => ipcRenderer.invoke('refresh'),
  setLeague:    (league)  => ipcRenderer.invoke('set-league', league),
  getLeagues:   ()        => ipcRenderer.invoke('get-leagues'),
  closeWindow:  ()        => ipcRenderer.invoke('close-window'),
  openDevTools: ()        => ipcRenderer.invoke('open-devtools'),
  openUrl:      (url)     => ipcRenderer.invoke('open-url', url),

  // Generic persistent prefs
  getPref: (key, def)     => ipcRenderer.invoke('get-pref', key, def),
  setPref: (key, val)     => ipcRenderer.invoke('set-pref', key, val),

  // Currency blacklist
  getBlacklist:        ()      => ipcRenderer.invoke('get-blacklist'),
  addToBlacklist:      (key)   => ipcRenderer.invoke('add-to-blacklist', key),
  removeFromBlacklist: (key)   => ipcRenderer.invoke('remove-from-blacklist', key),

  // Refresh interval (dedicated so main can restart the timer)
  setRefreshInterval: (ms) => ipcRenderer.invoke('set-refresh-interval', ms),

  // Notifications mute (dedicated so main can update tray menu)
  setNotificationsMuted: (muted) => ipcRenderer.invoke('set-notifications-muted', muted),

  onDataUpdate: (callback) => {
    ipcRenderer.on('data-update', (_event, data) => callback(data));
  },
  onNotificationsMutedChanged: (callback) => {
    ipcRenderer.on('notifications-muted-changed', (_event, muted) => callback(muted));
  },
});

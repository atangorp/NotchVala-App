const { execFile } = require('child_process');

/**
 * Spotify Cross-Platform Service
 * Supports:
 * - macOS: AppleScript (osascript) with sub-millisecond precision
 * - Windows: PowerShell Spotify Window Title tracking & Media Keys
 * - Linux: MPRIS DBus via playerctl
 */
class SpotifyService {
  /**
   * Fast check if Spotify is currently running in background
   */
  static isRunning() {
    return new Promise((resolve) => {
      if (process.platform === 'darwin') {
        execFile('pgrep', ['-x', 'Spotify'], (err, stdout) => {
          resolve(!err && Boolean(stdout && stdout.trim()));
        });
      } else if (process.platform === 'win32') {
        execFile('tasklist', ['/fi', 'imagename eq Spotify.exe'], (err, stdout) => {
          resolve(!err && Boolean(stdout && stdout.includes('Spotify.exe')));
        });
      } else if (process.platform === 'linux') {
        execFile('pgrep', ['-x', 'spotify'], (err, stdout) => {
          resolve(!err && Boolean(stdout && stdout.trim()));
        });
      } else {
        resolve(false);
      }
    });
  }

  /**
   * Execute AppleScript string asynchronously with strict timeout (macOS only)
   */
  static runScript(script, timeoutMs = 1500) {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout ? stdout.trim() : null);
      });
    });
  }

  /**
   * Windows Spotify Window Title query via PowerShell
   */
  static getWindowsPlayback() {
    return new Promise((resolve) => {
      const psCommand = `
        $p = Get-Process -Name spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle.Length -gt 0 }
        if ($p) {
          Write-Output ($p | Select-Object -First 1).MainWindowTitle
        } else {
          Write-Output "NONE"
        }
      `;
      execFile('powershell', ['-NoProfile', '-Command', psCommand], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const winTitle = stdout.trim();
        if (!winTitle || winTitle === 'NONE' || winTitle === 'Spotify' || winTitle === 'Spotify Free' || winTitle === 'Spotify Premium') {
          return resolve(null);
        }
        let artist = '';
        let title = winTitle;
        if (winTitle.includes(' - ')) {
          const parts = winTitle.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }
        resolve({
          source: 'spotify',
          state: 'playing',
          title,
          artist,
          album: '',
          position: 0,
          duration: 0,
          artwork: null,
          timestamp: Date.now()
        });
      });
    });
  }

  /**
   * Linux Spotify query via playerctl (MPRIS DBus)
   */
  static getLinuxPlayback() {
    return new Promise((resolve) => {
      execFile('playerctl', ['-p', 'spotify', 'metadata', '--format', '{{status}}|||{{title}}|||{{artist}}|||{{album}}|||{{position}}|||{{mpris:length}}|||{{mpris:artUrl}}'], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const parts = stdout.trim().split('|||');
        if (parts.length < 3) return resolve(null);
        const [status, title, artist, album, posUs, lenUs, artwork] = parts;
        resolve({
          source: 'spotify',
          state: (status || 'playing').toLowerCase(),
          title: (title || '').trim(),
          artist: (artist || '').trim(),
          album: (album || '').trim(),
          position: (parseFloat(posUs) || 0) / 1000000,
          duration: (parseFloat(lenUs) || 0) / 1000000,
          artwork: artwork || null,
          timestamp: Date.now()
        });
      });
    });
  }

  /**
   * Get current track and playback info from Spotify
   * @returns {Promise<Object|null>}
   */
  static async getCurrentPlayback() {
    const running = await this.isRunning();
    if (!running) return null;

    if (process.platform === 'win32') {
      return this.getWindowsPlayback();
    }
    if (process.platform === 'linux') {
      return this.getLinuxPlayback();
    }

    const script = `
tell application "Spotify"
    try
        set pState to player state as string
        if pState is "playing" or pState is "paused" then
            set trkName to name of current track
            set trkArtist to artist of current track
            set trkAlbum to album of current track
            set trkDuration to (duration of current track) / 1000.0
            set trkPos to player position
            set trkArt to artwork url of current track
            return pState & "|||" & trkName & "|||" & trkArtist & "|||" & trkAlbum & "|||" & trkPos & "|||" & trkDuration & "|||" & trkArt
        else
            return "stopped"
        end if
    on error
        return "error"
    end try
end tell
    `;

    const raw = await this.runScript(script);
    if (!raw || raw === 'stopped' || raw === 'error' || !raw.includes('|||')) {
      return null;
    }

    const parts = raw.split('|||');
    if (parts.length < 5) return null;

    const [state, title, artist, album, positionStr, durationStr, artwork] = parts;
    const position = parseFloat((positionStr || '').replace(',', '.')) || 0;
    const duration = parseFloat((durationStr || '').replace(',', '.')) || 0;

    return {
      source: 'spotify',
      state: state.toLowerCase(),
      title: (title || '').trim(),
      artist: (artist || '').trim(),
      album: (album || '').trim(),
      position,
      duration,
      artwork: (artwork && artwork !== 'missing value') ? artwork.trim() : null,
      timestamp: Date.now()
    };
  }

  static async playPause() {
    const running = await this.isRunning();
    if (!running) return null;
    if (process.platform === 'darwin') {
      return this.runScript('tell application "Spotify" to playpause');
    } else if (process.platform === 'win32') {
      const ps = `(New-Object -ComObject WScript.Shell).SendKeys([char]179)`;
      return new Promise((res) => execFile('powershell', ['-NoProfile', '-Command', ps], () => res(true)));
    } else if (process.platform === 'linux') {
      return new Promise((res) => execFile('playerctl', ['-p', 'spotify', 'play-pause'], () => res(true)));
    }
  }

  static async next() {
    const running = await this.isRunning();
    if (!running) return null;
    if (process.platform === 'darwin') {
      return this.runScript('tell application "Spotify" to next track');
    } else if (process.platform === 'win32') {
      const ps = `(New-Object -ComObject WScript.Shell).SendKeys([char]176)`;
      return new Promise((res) => execFile('powershell', ['-NoProfile', '-Command', ps], () => res(true)));
    } else if (process.platform === 'linux') {
      return new Promise((res) => execFile('playerctl', ['-p', 'spotify', 'next'], () => res(true)));
    }
  }

  static async previous() {
    const running = await this.isRunning();
    if (!running) return null;
    if (process.platform === 'darwin') {
      return this.runScript('tell application "Spotify" to previous track');
    } else if (process.platform === 'win32') {
      const ps = `(New-Object -ComObject WScript.Shell).SendKeys([char]177)`;
      return new Promise((res) => execFile('powershell', ['-NoProfile', '-Command', ps], () => res(true)));
    } else if (process.platform === 'linux') {
      return new Promise((res) => execFile('playerctl', ['-p', 'spotify', 'previous'], () => res(true)));
    }
  }

  static async seek(seconds) {
    const running = await this.isRunning();
    if (!running) return null;
    if (process.platform === 'darwin') {
      return this.runScript(`tell application "Spotify" to set player position to (player position + (${seconds}))`);
    } else if (process.platform === 'linux') {
      return new Promise((res) => execFile('playerctl', ['-p', 'spotify', 'position', `${seconds}+`], () => res(true)));
    }
    return null;
  }
}

module.exports = SpotifyService;

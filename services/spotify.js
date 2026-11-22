const { execFile } = require('child_process');

/**
 * Spotify macOS Service via AppleScript
 * Queries native Spotify Desktop client for current track, playback state, and position.
 * Uses direct osascript without System Events to avoid macOS permission hangs.
 */
class SpotifyService {
  /**
   * Fast check if Spotify is currently running in background (takes ~2ms, no AppleScript permissions needed)
   */
  static isRunning() {
    return new Promise((resolve) => {
      execFile('pgrep', ['-x', 'Spotify'], (err, stdout) => {
        resolve(!err && Boolean(stdout && stdout.trim()));
      });
    });
  }

  /**
   * Execute AppleScript string asynchronously with strict timeout
   */
  static runScript(script, timeoutMs = 1500) {
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout ? stdout.trim() : null);
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
    return this.runScript('tell application "Spotify" to playpause');
  }

  static async next() {
    const running = await this.isRunning();
    if (!running) return null;
    return this.runScript('tell application "Spotify" to next track');
  }

  static async previous() {
    const running = await this.isRunning();
    if (!running) return null;
    return this.runScript('tell application "Spotify" to previous track');
  }

  static async seek(seconds) {
    const running = await this.isRunning();
    if (!running) return null;
    return this.runScript(`tell application "Spotify" to set player position to (player position + (${seconds}))`);
  }
}

module.exports = SpotifyService;

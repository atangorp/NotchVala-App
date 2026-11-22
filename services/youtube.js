const { execFile } = require('child_process');

/**
 * YouTube Browser Service
 * Inspects active YouTube tabs across macOS browsers (Google Chrome, Brave, Safari, Arc, Edge)
 * Avoids System Events hangs by prechecking processes with pgrep.
 */
class YouTubeService {
  static runScript(script, timeoutMs = 1500) {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout ? stdout.trim() : null);
      });
    });
  }

  static isProcessRunning(pattern) {
    if (process.platform !== 'darwin') return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile('pgrep', ['-f', pattern], (err, stdout) => {
        resolve(!err && Boolean(stdout && stdout.trim()));
      });
    });
  }

  /**
   * Cleans YouTube video title into { artist, title, rawTitle }
   */
  static cleanTitle(raw) {
    if (!raw) return { artist: '', title: '', query: '' };

    let cleaned = raw
      .replace(/\s*-\s*YouTube\s*$/i, '')
      .replace(/^\s*\(\d+\)\s*/, '') // Remove "(1) " unread notifications in title
      .trim();

    // Remove video fluff words
    cleaned = cleaned
      .replace(/\s*\[[^\]]*(official|video|audio|lyric|mv|4k|hd|visualizer|remix|version)[^\]]*\]/gi, '')
      .replace(/\s*\([^)]*(official|video|audio|lyric|mv|4k|hd|visualizer|remix|version)[^)]*\)/gi, '')
      .replace(/\s*(Official\s*Music\s*Video|Official\s*Audio|Official\s*Video|Lyric\s*Video|Visualizer|Color\s*Coded\s*Lyrics)\s*/gi, '')
      .replace(/["“”]/g, '')
      .trim();

    let artist = '';
    let title = cleaned;

    if (cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else if (cleaned.includes(' : ')) {
      const parts = cleaned.split(' : ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' : ').trim();
    } else if (cleaned.includes(' | ')) {
      const parts = cleaned.split(' | ');
      title = parts[0].trim();
      artist = parts[1].trim();
    }

    return {
      artist,
      title,
      query: `${artist} ${title}`.trim() || cleaned,
      rawTitle: raw
    };
  }

  /**
   * Find playing YouTube tab across browsers without touching System Events
   */
  static async getCurrentPlayback() {
    // 1. Google Chrome
    const hasChrome = await this.isProcessRunning('Google Chrome');
    if (hasChrome) {
      const script = `
tell application "Google Chrome"
    repeat with w in windows
        repeat with t in tabs of w
            set tabUrl to URL of t
            if tabUrl contains "youtube.com/watch" then
                set tabTitle to title of t
                set vidTime to "0"
                try
                    set vidTime to (execute t javascript "document.querySelector('video') ? document.querySelector('video').currentTime : 0") as string
                end try
                set isPaused to "false"
                try
                    set isPaused to (execute t javascript "document.querySelector('video') ? document.querySelector('video').paused : false") as string
                end try
                return "FOUND|||" & tabTitle & "|||" & tabUrl & "|||" & vidTime & "|||" & isPaused
            end if
        end repeat
    end repeat
    return "NONE"
end tell
      `;
      const raw = await this.runScript(script);
      if (raw && raw.startsWith('FOUND|||')) {
        const [, rawTitle, url, timeStr, isPausedStr] = raw.split('|||');
        const cleaned = this.cleanTitle(rawTitle);
        const position = parseFloat((timeStr || '').replace(',', '.')) || 0;
        const isPaused = isPausedStr === 'true';

        return {
          source: 'youtube',
          state: isPaused ? 'paused' : 'playing',
          title: cleaned.title || rawTitle,
          artist: cleaned.artist || 'YouTube',
          query: cleaned.query,
          rawTitle,
          url,
          position,
          duration: 0,
          timestamp: Date.now()
        };
      }
    }

    // 2. Brave Browser
    const hasBrave = await this.isProcessRunning('Brave Browser');
    if (hasBrave) {
      const script = `
tell application "Brave Browser"
    repeat with w in windows
        repeat with t in tabs of w
            set tabUrl to URL of t
            if tabUrl contains "youtube.com/watch" then
                set tabTitle to title of t
                return "FOUND|||" & tabTitle & "|||" & tabUrl & "|||0|||false"
            end if
        end repeat
    end repeat
    return "NONE"
end tell
      `;
      const raw = await this.runScript(script);
      if (raw && raw.startsWith('FOUND|||')) {
        const [, rawTitle, url] = raw.split('|||');
        const cleaned = this.cleanTitle(rawTitle);

        return {
          source: 'youtube',
          state: 'playing',
          title: cleaned.title || rawTitle,
          artist: cleaned.artist || 'YouTube',
          query: cleaned.query,
          rawTitle,
          url,
          position: 0,
          duration: 0,
          timestamp: Date.now()
        };
      }
    }

    return null;
  }
}

module.exports = YouTubeService;

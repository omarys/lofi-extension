// Streams the lofi feed through mpv, controlled over mpv's JSON IPC socket.
// Using the socket rather than owning mpv's stdout means we can attach to an
// mpv the user already has running, and pause/volume changes are one-liners.
//
// ponytail: the paused flag is tracked locally, so external control of mpv
// (a second client on the same socket) would desync it. Add
// "observe_property" if that ever matters.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.IOStream.prototype, 'close_async', 'close_finish');

export const DEFAULT_URL = 'https://www.youtube.com/watch?v=1-LpQekNa9g';

const SOCKET_PATH = GLib.build_filenamev([
    GLib.get_user_runtime_dir(),
    'lofi-extension-mpv.sock',
]);

export class Music {
    constructor() {
        this._process = null;
        this._connection = null;
        this._paused = false;
        this._url = null;   // the URL the live mpv was spawned with
        this._onChange = null;
        this._onError = null;
        this._ioChain = Promise.resolve();
    }

    /**
     * Called whenever playback starts, pauses or stops, so the panel can follow
     * a stream that was started over D-Bus instead of from its own button.
     */
    set onChange(callback) {
        this._onChange = callback;
    }

    /** Called with a user-facing message when mpv fails to start or crashes. */
    set onError(callback) {
        this._onError = callback;
    }

    /** True while mpv is up and not paused. */
    get playing() {
        // Not `_connection`: mpv plays from the moment it spawns, and the
        // socket only appears a moment later. _spawn clears _process on exit.
        return !this._paused && this._process !== null;
    }

    /** 'playing', 'paused' or 'off' — what GetState reports over D-Bus. */
    get state() {
        if (this._paused)
            return 'paused';
        return this._process === null ? 'off' : 'playing';
    }

    play(url = DEFAULT_URL, volume = 40) {
        // Reuse the mpv we already own. mpv plays whatever URL it was spawned
        // with, so a changed URL means restarting it and the same URL only
        // needs unpausing. Never spawn a second one here: the IPC socket is
        // briefly absent right after a spawn, and falling through to _spawn in
        // that window started a duplicate stream alongside the first.
        if (this._process !== null) {
            if (url !== this._url) {
                this.stop();
                return this._spawn(url, volume);
            }
            this._command(['set_property', 'pause', false]);
            this._paused = false;   // resuming the mpv we paused earlier
            this._notify();
            return true;
        }
        return this._spawn(url, volume);
    }

    pause() {
        if (this._process === null)
            return;
        this._command(['set_property', 'pause', true]);
        this._paused = true;
        this._notify();
    }

    toggle(url, volume) {
        if (this.playing)
            this.pause();
        else
            this.play(url, volume);
    }

    setVolume(volume) {
        if (this._process === null)
            return;
        this._command(['set_property', 'volume', volume]);
    }

    /**
     * Tears the stream down for good: the mpv we spawned and any stray one
     * still listening on the socket, which a crashed shell can leave resident.
     */
    reset() {
        const hadProcess = this._process !== null;
        this._process?.force_exit();
        this._process = null;
        this._paused = false;
        this._url = null;
        this._notify();

        this._enqueue(async () => {
            if (!hadProcess)
                await this._sendCommand(['quit']);
            await this._closeAsync();
            if (this._process === null)
                GLib.unlink(SOCKET_PATH);
        });
    }

    stop() {
        this._process?.force_exit();
        this._process = null;
        this._paused = false;
        this._url = null;
        this._notify();

        this._enqueue(async () => {
            await this._closeAsync();
            if (this._process === null)
                GLib.unlink(SOCKET_PATH);
        });
    }

    /* ------------------------------------------------------------- internals */

    _notify() {
        try {
            this._onChange?.();
        } catch (e) {
            logError(e, 'lofi: state callback failed');
        }
    }

    _reportError(message) {
        try {
            this._onError?.(message);
        } catch (e) {
            logError(e, 'lofi: error callback failed');
        }
    }

    _spawn(url, volume) {
        // A socket file left behind by a dead mpv would stop a new one binding,
        // so clear it before starting.
        GLib.unlink(SOCKET_PATH);

        try {
            this._process = Gio.Subprocess.new(
                ['mpv', '--no-video', '--no-terminal', '--really-quiet',
                    // YouTube needs an audio-only pick: the default may be a
                    // video stream whose muxed audio mpv then has to discard.
                    '--ytdl-format=bestaudio/best',
                    `--input-ipc-server=${SOCKET_PATH}`, `--volume=${volume}`, url],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'lofi: could not start mpv');
            this._reportError('Could not start mpv. Make sure mpv and yt-dlp are installed.');
            return false;
        }

        // mpv is already playing the URL it was launched with; the socket is
        // only needed for pause/volume, so it can appear whenever it likes.
        this._paused = false;
        this._url = url;

        // Waiting also reaps mpv, which would otherwise sit around as a zombie,
        // and doubles as the liveness signal for `playing`.
        const process = this._process;
        process.wait_async(null, (proc, result) => {
            let ok = true;
            try {
                proc.wait_finish(result);
                ok = proc.get_successful();
            } catch {
                // wait failed; the process is still gone as far as we care
                ok = false;
            }
            if (this._process !== process)
                return;
            this._process = null;
            this._paused = false;
            this._url = null;
            this._notify();   // mpv died on its own, so the button must follow
            if (!ok)
                this._reportError('mpv exited unexpectedly. Check the stream URL and yt-dlp.');
        });

        this._notify();
        return true;
    }

    _enqueue(fn) {
        this._ioChain = this._ioChain.then(fn).catch(e => {
            logError(e, 'lofi: IPC operation failed');
        });
        return this._ioChain;
    }

    _command(args) {
        this._enqueue(() => this._sendCommand(args));
    }

    async _sendCommand(args) {
        const connection = this._connection ?? await this._connectAsync();
        if (connection === null)
            return false;
        this._connection = connection;
        try {
            const payload = new TextEncoder().encode(`${JSON.stringify({command: args})}\n`);
            await connection.get_output_stream().write_bytes_async(
                new GLib.Bytes(payload), GLib.PRIORITY_DEFAULT, null);
            return true;
        } catch {
            this._connection = null;
            return false;
        }
    }

    async _connectAsync() {
        if (!GLib.file_test(SOCKET_PATH, GLib.FileTest.EXISTS))
            return null;
        try {
            return await new Gio.SocketClient().connect_async(
                Gio.UnixSocketAddress.new(SOCKET_PATH), null);
        } catch {
            return null;   // not listening
        }
    }

    async _closeAsync() {
        const connection = this._connection;
        this._connection = null;
        if (connection === null)
            return;
        try {
            await connection.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch {
            // already closed
        }
    }
}

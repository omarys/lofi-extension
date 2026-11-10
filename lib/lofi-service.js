// The stream as a service: owns org.omary.Lofi on the session bus so other
// extensions (the pomodoro timer) can start and stop the music without
// reaching into this extension's internals.
//
// The interface is the contract. Keep it additive: a caller that ships against
// Play/Pause/Stop/Toggle/GetState must keep working after a rewrite here.

import Gio from 'gi://Gio';

export const BUS_NAME = 'org.omary.Lofi';
export const OBJECT_PATH = '/org/omary/Lofi';

const XML = `
<node>
  <interface name="org.omary.Lofi">
    <method name="Play">
      <arg type="s" direction="in" name="url"/>
      <arg type="b" direction="out" name="started"/>
    </method>
    <method name="Pause">
      <arg type="b" direction="out" name="paused"/>
    </method>
    <method name="Stop">
      <arg type="b" direction="out" name="stopped"/>
    </method>
    <method name="Toggle">
      <arg type="b" direction="out" name="playing"/>
    </method>
    <method name="GetState">
      <arg type="s" direction="out" name="state"/>
    </method>
  </interface>
</node>`;

export class LofiService {
    /**
     * `music` is a Music-like object and `settings` the extension settings; both
     * are injected so the D-Bus test can drive this without spawning mpv.
     * A caller may pass an empty URL to play whatever the user configured.
     */
    constructor(music, settings) {
        this._music = music;
        this._settings = settings;
        this._exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._nameId = 0;
    }

    /** Publishes the object and takes the well-known name. */
    own() {
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE, null, null);
    }

    /** Drops the name and the object; a caller then gets a "no such name" error. */
    unown() {
        if (this._nameId !== 0) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._exported.unexport();
    }

    /* --------------------------------------------------- org.omary.Lofi */

    Play(url) {
        const target = url.trim() === '' ? this._configuredUrl() : url;
        return this._music.play(target, this._settings.get_int('volume'));
    }

    Pause() {
        this._music.pause();
        return this._music.state === 'paused';
    }

    /** Stops for good, including an mpv left behind by a crashed shell. */
    Stop() {
        this._music.reset();
        return true;
    }

    Toggle() {
        this._music.toggle(this._configuredUrl(), this._settings.get_int('volume'));
        return this._music.playing;
    }

    GetState() {
        return this._music.state;
    }

    _configuredUrl() {
        const url = this._settings.get_string('stream-url').trim();
        return url === '' ? undefined : url;
    }
}

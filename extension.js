// Panel button: left click toggles the stream, right click opens the menu.
//
// The stream itself lives in lib/music.js and is published on D-Bus by
// lib/lofi-service.js, so other extensions drive the same single mpv.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LofiService} from './lib/lofi-service.js';
import {Music} from './lib/music.js';

const NAME = 'Lofi Stream';
const VERSION = '1.0';

const LofiIndicator = GObject.registerClass(
    {GTypeName: 'LofiIndicator'},
    class LofiIndicator extends PanelMenu.Button {
        _init(settings, music, extension) {
            super._init(0.5, NAME);

            this._settings = settings;
            this._music = music;
            this._extension = extension;
            this._syncing = false;

            this._icon = new St.Icon({
                icon_name: 'media-playback-start-symbolic',
                style_class: 'system-status-icon',
            });
            this.add_child(this._icon);

            this._buildMenu();
            this._sync();

            // Handled in the capture phase rather than vfunc_event: since GNOME
            // 51 the menu is opened by a Clutter.ClickGesture action, and only a
            // captured event is guaranteed to be seen before that action runs.
            this.connect('captured-event', (_actor, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                    return Clutter.EVENT_PROPAGATE;
                switch (event.get_button()) {
                case 1:   // plain click toggles the stream
                    if (this.menu.isOpen)
                        return Clutter.EVENT_PROPAGATE;   // that click closes it
                    this._setMusic(!this._music.playing);
                    return Clutter.EVENT_STOP;
                case 3:   // right click drops the menu down
                    this.menu.toggle();
                    return Clutter.EVENT_STOP;
                default:
                    return Clutter.EVENT_PROPAGATE;
                }
            });
        }

        /* ------------------------------------------------------------- menu */

        _buildMenu() {
            this._musicItem = new PopupMenu.PopupSwitchMenuItem('Lofi stream', false);
            // Toggling shouldn't dismiss the menu. Chaining to super.activate()
            // is what closes it, so don't. GNOME's own space-key path returns
            // before that call for this same reason.
            this._musicItem.activate = function () {
                this.toggle();
            };
            this._musicItem.connect('toggled', (_item, active) => {
                // setToggleState() re-emits 'toggled', so ignore our own sync.
                if (this._syncing)
                    return;
                this._setMusic(active);
            });
            this.menu.addMenuItem(this._musicItem);

            // The switch off does the same thing, but only while the menu
            // still believes the stream is on: an mpv orphaned by a crashed
            // shell keeps running, so give it an explicit way out.
            const resetItem = new PopupMenu.PopupImageMenuItem(
                'Reset stream', 'view-refresh-symbolic');
            resetItem.connect('activate', () => this._music.reset());
            this.menu.addMenuItem(resetItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
            prefsItem.connect('activate', () => this._extension.openPreferences());
            this.menu.addMenuItem(prefsItem);

            this._aboutItem = new PopupMenu.PopupSubMenuMenuItem('About');
            for (const text of [NAME, `Version ${VERSION}`,
                'Lofi in the panel, played through mpv. No license.']) {
                this._aboutItem.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(text, {reactive: false}));
            }
            this.menu.addMenuItem(this._aboutItem);
        }

        /* --------------------------------------------------------- playback */

        _url() {
            const url = this._settings.get_string('stream-url').trim();
            return url === '' ? undefined : url;
        }

        /**
         * `play` starts or resumes the stream; off closes mpv outright rather
         * than pausing it, so a manual off actually frees the process.
         */
        _setMusic(play) {
            if (play)
                this._music.play(this._url(), this._settings.get_int('volume'));
            else
                this._music.reset();
            this._sync();
        }

        _sync() {
            const playing = this._music.playing;
            this._syncing = true;
            this._musicItem.setToggleState(playing);
            this._syncing = false;
            this._icon.icon_name = playing
                ? 'media-playback-stop-symbolic'
                : 'media-playback-start-symbolic';
            this.accessible_name = playing
                ? `${NAME} — playing`
                : `${NAME} — stopped`;
        }

        destroy() {
            // Music outlives the button: disable() stops it after this returns,
            // and a callback into a destroyed menu item would throw.
            this._music.onChange = null;
            this._aboutItem = null;
            this._musicItem = null;
            super.destroy();
        }
    });

export default class LofiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._music = new Music();
        this._service = new LofiService(this._music, this._settings);
        this._service.own();
        this._indicator = new LofiIndicator(this._settings, this._music, this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // The timer drives the same mpv over D-Bus, so the icon has to follow
        // changes it did not cause itself.
        this._music.onChange = () => this._indicator?._sync();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._service.unown();
        this._service = null;
        this._music.stop();
        this._music = null;
        this._settings = null;
    }
}

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// The prefs base class lives in the Extensions app's resource bundle, not the
// shell's: capital "Shell" and an extra js/ segment. Note the asymmetry with
// extension.js, which does live at resource:///org/gnome/shell/extensions/.
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LofiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Lofi',
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Stream',
            description: 'Played by mpv. Left click the panel icon to toggle it, ' +
                'right click for this menu. Other extensions can start and stop ' +
                'it through org.omary.Lofi on the session bus.',
        });
        page.add(group);

        const url = new Adw.EntryRow({
            title: 'Stream URL',
            text: settings.get_string('stream-url'),
            show_apply_button: true,
        });
        url.connect('apply', () => settings.set_string('stream-url', url.text));
        group.add(url);

        const volume = new Adw.SpinRow({
            title: 'Volume',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
        });
        settings.bind('volume', volume, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(volume);
    }
}

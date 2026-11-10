import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

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
        });
        url.connect('changed', () => settings.set_string('stream-url', url.text));
        group.add(url);

        const volume = new Adw.SpinRow({
            title: 'Volume',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
            value: settings.get_int('volume'),
        });
        volume.connect('notify::value', () =>
            settings.set_int('volume', Math.round(volume.value)));
        group.add(volume);
    }
}

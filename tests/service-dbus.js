#!/usr/bin/env -S gjs -m
// Drives lib/lofi-service.js, which is the contract the pomodoro timer calls
// into. Two layers: direct method calls with a fake player (no bus needed, so
// this runs anywhere), then one real round trip over the session bus when the
// environment has one, because the wire signature is exactly what breaks a
// caller silently.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LofiService, BUS_NAME, OBJECT_PATH} from '../lib/lofi-service.js';

const CONFIGURED = 'https://example.test/configured';

let failures = 0;

function check(what, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failures++;
    print(`${ok ? '  ok  ' : '  FAIL'} ${what}` +
        (ok ? '' : `\n         want ${JSON.stringify(expected)}` +
            `\n         got  ${JSON.stringify(actual)}`));
}

// Stands in for Music: records what it was asked to do and keeps just enough
// state for the answers the service derives from it.
class FakeMusic {
    constructor() {
        this.calls = [];
        this.playing = false;
        this.state = 'off';
    }

    play(url, volume) {
        this.calls.push(['play', url, volume]);
        this.playing = true;
        this.state = 'playing';
        return true;
    }

    pause() {
        this.calls.push(['pause']);
        this.playing = false;
        this.state = 'paused';
    }

    reset() {
        this.calls.push(['reset']);
        this.playing = false;
        this.state = 'off';
    }

    toggle(url, volume) {
        this.calls.push(['toggle', url, volume]);
        this.playing = !this.playing;
        this.state = this.playing ? 'playing' : 'paused';
    }
}

const settings = {
    get_string: key => (key === 'stream-url' ? CONFIGURED : ''),
    get_int: key => (key === 'volume' ? 40 : 0),
};

/* --------------------------------------------------------- direct calls */

print('service without a bus');

const music = new FakeMusic();
const service = new LofiService(music, settings);

// An empty URL is the pomodoro timer's whole API: "start whatever is set up".
check('Play("") uses the configured stream',
    service.Play(''), true);
check('  ... and the configured volume', music.calls.at(-1), ['play', CONFIGURED, 40]);

check('Play(url) honours an explicit URL', service.Play('https://x.test/a'), true);
check('  ... passing it straight through', music.calls.at(-1), ['play', 'https://x.test/a', 40]);

service.Pause();
check('Pause pauses rather than stopping', music.calls.at(-1), ['pause']);
check('  ... and reports that', service.Pause(), true);

check('GetState follows the player', service.GetState(), 'paused');

check('Toggle resumes from paused', service.Toggle(), true);
check('  ... with the configured stream', music.calls.at(-1), ['toggle', CONFIGURED, 40]);

check('Stop tears the player down', service.Stop(), true);
check('  ... via reset(), which also kills a stray mpv', music.calls.at(-1), ['reset']);
check('  ... and leaves it off', service.GetState(), 'off');

/* ---------------------------------------------------------- over the bus */

let bus = null;
try {
    bus = Gio.DBus.session;
} catch {
    bus = null;
}

if (bus === null) {
    print('bus round trip skipped — no session bus in this environment');
} else {
    print('service over the session bus');

    const busMusic = new FakeMusic();
    const busService = new LofiService(busMusic, settings);
    const loop = new GLib.MainLoop(null, false);
    const unique = bus.get_unique_name();

    // One call per method, resolved by the main loop so the exported object's
    // dispatch actually runs.
    const call = (method, parameters) => new Promise(resolve => {
        bus.call(unique, OBJECT_PATH, BUS_NAME, method, parameters, null,
            Gio.DBusCallFlags.NONE, 5000, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack()[0]);
                } catch (e) {
                    resolve(e.message);
                }
            });
    });

    busService._exported.export(bus, OBJECT_PATH);

    const run = async () => {
        // Same shape the pomodoro timer sends: an empty string for Play and
        // no parameters at all for Pause and Stop.
        check('Play("") over the bus', await call('Play', new GLib.Variant('(s)', [''])), true);
        check('  ... reached the player', busMusic.calls.at(-1), ['play', CONFIGURED, 40]);

        check('Pause over the bus', await call('Pause', null), true);
        check('Toggle over the bus', await call('Toggle', null), true);
        check('GetState over the bus', await call('GetState', null), 'playing');
        check('Stop over the bus', await call('Stop', null), true);
        check('  ... reached the player', busMusic.calls.at(-1), ['reset']);
    };

    run().catch(e => {
        failures++;
        print(`  FAIL bus round trip threw: ${e.message}`);
    }).finally(() => loop.quit());

    // A hung bus must not hang the check task.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => loop.quit());
    loop.run();
    busService._exported.unexport();
}

print(failures === 0 ? 'ok' : `${failures} failure(s)`);
if (failures !== 0)
    throw new Error(`${failures} service check(s) failed`);

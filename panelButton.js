// Copyright(C) 2021  Emre Şenliyim

// This program is free software: you can redistribute it and / or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
//     (at your option) any later version.

// This program is distributed in the hope that it will be useful,
//     but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.See the
// GNU General Public License for more details.

//     You should have received a copy of the GNU General Public License
// along with this program.If not, see < http://www.gnu.org/licenses/>.

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const { St, Clutter, GObject, Gio, GLib } = imports.gi;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const { SpTrayDbus } = Me.imports.dbus;
const { settingsFields } = Me.imports.settingsFields;
const ExtensionUtils = imports.misc.extensionUtils;

const marqueeTextGenerator = function* (label) {
    const length = this.settings.get_int("marquee-length");
    const separator = this.settings.get_string("marquee-tail");

    const text = (label + separator).split("");

    while (true) {
        yield text.join("").slice(0, length);
        text.push(text.shift());
    }
};

var SpTrayButton = GObject.registerClass(
    { GTypeName: "SpTrayButton" },
    class SpTrayButton extends PanelMenu.Button {
        _init() {
            super._init(null, Me.metadata.name);

            this.ui = new Map();
            this._settingSignals = [];
            this._signals = [];
            this.marqueeTimeoutId = null;

            this._initSettings();
            this._initDbus();
            this._initUi();

            this.updateLabel(true);
        }

        _initSettings() {
            this.settings = ExtensionUtils.getSettings();

            // connect relevant settings to the button so that it can be instantly updated when they're changed
            // store the connected signals in an array for easy disconnection later on
            settingsFields.forEach((field) => {
                if (field.changeCallback) {
                    this._settingSignals.push(
                        this.settings.connect(
                            `changed::${field.setting}`,
                            this[field.changeCallback].bind(this),
                        ),
                    );
                } else {
                    this._settingSignals.push(
                        this.settings.connect(
                            `changed::${field.setting}`,
                            this.updateLabel.bind(this, field.restartsAnimation),
                        ),
                    );
                }
            });
        }

        _initUi() {
            const box = new St.BoxLayout({
                style_class: "panel-status-menu-box",
            });
            this.ui.set("box", box);

            // TODO mess with css to see if I can stop the label from jumping slightly left and right while marquee is on
            this.ui.set(
                "label",
                new St.Label({
                    text: this.settings.get_string("starting"),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );

            this.ui.set(
                "pausedState",
                new St.Label({
                    text: this.settings.get_string("paused"),
                    visible: false,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
            this.ui.set("icon", this.makeIcon());
            this._handleLogoDisplay();

            this._signals.push(this.connect("button-press-event", this.showSpotify.bind(this)));

            this.add_child(box);
        }

        /**
         * Currently supports 3 builds: 1) native builds where the app icon is where every other app's is 2) Snap packages 3) Flatpak packages
         * First checks for Snap. If there's no file associated with it, sets the icon to the native build's icon, with the Flatpak icon path
         * as fallback
         */
        makeIcon() {
            const snapFileContents = this.readSnapFile();
            if (snapFileContents) {
                // There's a snap build of Spotify installed
                const gicon = Gio.icon_new_for_string(snapFileContents);
                return new St.Icon({
                    gicon,
                    style_class: "system-status-icon",
                });
            }
            return new St.Icon({
                icon_name: "spotify",
                style_class: "system-status-icon",
                fallback_icon_name: "com.spotify.Client", // icon name for flatpak, in case it's not a native build
            });
        }

        readSnapFile() {
            try {
                const [ok, contents] = GLib.file_get_contents(
                    "/var/lib/snapd/desktop/applications/spotify_spotify.desktop",
                );
                if (!ok) {
                    return false;
                }
                const matched = String.fromCharCode(...contents).match(/Icon=(.*)\n/m);
                return matched ? matched[1] : false;
            } catch (error) {
                return false;
            }
        }

        _initDbus() {
            this.dbus = new SpTrayDbus(this);
        }

        // if the spotify logo is to be shown, insert it where appropriate (sounded better in my head)
        _handleLogoDisplay() {
            let box = this.ui.get("box");
            switch (this.settings.get_int("logo-position")) {
                case 0:
                    box.remove_all_children();
                    box.add_child(this.ui.get("pausedState"));
                    box.add_child(this.ui.get("label"));
                    break;
                case 1:
                    box.remove_all_children();
                    box.add_child(this.ui.get("icon"));
                    box.add_child(this.ui.get("pausedState"));
                    box.add_child(this.ui.get("label"));
                    break;
                case 2:
                    box.remove_all_children();
                    box.add_child(this.ui.get("pausedState"));
                    box.add_child(this.ui.get("label"));
                    box.add_child(this.ui.get("icon"));
                    break;
            }
        }

        //move the label to its new location
        _positionChanged() {
            this.container.get_parent().remove_actor(this.container);

            let positions = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];

            let pos = this.settings.get_int("position");
            positions[pos].insert_child_at_index(this.container, pos === 2 ? 0 : -1);
        }

        destroy() {
            // disconnect all signals
            this._settingSignals.forEach((signal) => {
                this.settings.disconnect(signal);
            });
            this._signals.forEach((signal) => {
                this.disconnect(signal);
            });
            // destroy all ui elements
            this.ui.get("box").destroy();
            this.dbus.destroy();
            if (this.marqueeTimeoutId) GLib.Source.remove(this.marqueeTimeoutId);
            super.destroy();
        }

        showPaused(metadata, shouldRestart = false) {
            if (this.settings.get_boolean("hidden-when-paused")) {
                this.visible = false;
                return;
            } else {
                this.visible = true;
                const pbStat = this.ui.get("pausedState");
                pbStat.visible = true;
                pbStat.text = this.settings.get_string("paused");
                if (this.settings.get_boolean("metadata-when-paused")) {
                    this._updateText(metadata, shouldRestart);
                } else {
                    this._pauseMarquee();
                    this.ui.get("label").visible = false;
                }
            }
        }

        showPlaying(metadata, shouldRestart = false) {
            this.visible = true;
            this.ui.get("label").visible = true;
            const pbStat = this.ui.get("pausedState");
            pbStat.visible = false;
            this._updateText(metadata, shouldRestart);
        }

        _updateText(metadata, shouldRestart = false) {
            const format = this._getFormat(metadata.trackType);
            const button = this.ui.get("label");
            if (!format) {
                // we got something completely unrecognizable I guess so don't put anything on there
                button.set_text("");
                return;
            }
            button.set_text(this._makeText(metadata, shouldRestart));
        }

        showInactive() {
            if (this.settings.get_boolean("hidden-when-inactive")) {
                this.visible = false;
            } else {
                this.visible = true;
                const pbStat = this.ui.get("pausedState");
                pbStat.visible = true;
                pbStat.text = this.settings.get_string("off");
                const button = this.ui.get("label");
                button.visible = false;
            }
            this._stopMarquee();
        }

        showStopped() {
            if (this.settings.get_boolean("hidden-when-stopped")) {
                this.visible = false;
            } else {
                this.visible = true;
                const pbStat = this.ui.get("pausedState");
                pbStat.visible = true;
                pbStat.text = this.settings.get_string("stopped");
                const button = this.ui.get("label");
                button.visible = false;
            }
            this._stopMarquee();
        }

        // update the text on the tray display
        updateLabel(shouldRestart = true) {
            if (!this.dbus.spotifyIsActive()) {
                this.showInactive();
                return;
            }
            switch (this.dbus.getPlaybackStatus()) {
                case "Playing":
                    this.showPlaying(this.dbus.extractMetadataInformation(), shouldRestart);
                    return;
                case "Paused":
                    this.showPaused(this.dbus.extractMetadataInformation(), shouldRestart);
                    return;
                case "Stopped":
                default:
                    this.showStopped();
                    return;
            }
        }

        _getFormat(trackType) {
            switch (trackType) {
                case "track":
                case "local":
                    return this.settings.get_string("display-format");
                case "episode":
                    return this.settings.get_string("podcast-format");
                default:
                    return null;
            }
        }

        _makeText(metadata, shouldRestart) {
            if (!this._getFormat(metadata.trackType)) {
                return "";
            }
            return this.settings.get_int("display-mode") === 1
                ? this._generateMarqueeText(metadata, shouldRestart)
                : this._generateStaticText(metadata);
        }

        _generateMarqueeText(metadata, shouldRestart) {
            GLib.Source.remove(this.marqueeTimeoutId);
            const text = this._createFormattedText(metadata);
            if (text.length <= this.settings.get_int("marquee-length")) return text;
            if (shouldRestart || !this.marqueeGenerator) {
                this.marqueeGenerator = marqueeTextGenerator.apply(this, [
                    this._createFormattedText(metadata),
                ]);
            }
            this.marqueeTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this.settings.get_int("marquee-interval"),
                () => this.updateLabel(false),
            );
            return this.marqueeGenerator.next().value;
        }

        _createFormattedText(metadata) {
            return this._getFormat(metadata.trackType)
                .replace("{artist}", metadata.artist)
                .replace("{track}", metadata.title)
                .replace("{album}", metadata.album)
                .replace("{pbctr}", this.getPlaybackControl())
                .trim();
        }

        _generateStaticText(metadata) {
            this._stopMarquee();
            let maxTitleLength = this.settings.get_int("title-max-length");
            let maxArtistLength = this.settings.get_int("artist-max-length");
            let maxAlbumLength = this.settings.get_int("album-max-length");

            if (metadata.title.length > maxTitleLength) {
                metadata.title = metadata.title.slice(0, maxTitleLength) + "...";
            }

            if (metadata.album.length > maxAlbumLength) {
                metadata.album = metadata.album.slice(0, maxAlbumLength) + "...";
            }

            // As of May 2022 podcasts return a blank string for this field, but I'm leaving this in, in case that
            // changes in the future and the artist field starts returning something
            if (metadata.artist.length > maxArtistLength) {
                metadata.artist = metadata.artist.slice(0, maxArtistLength) + "...";
            }
            return this._createFormattedText(metadata);
        }

        getPlaybackControl() {
            const controls = this.dbus.getPlaybackControl();
            let text = "";
            if (!controls) {
                return text;
            }
            if (controls.shuffle) {
                text += `${this.settings.get_string("shuffle")} `;
            }
            switch (controls.loop) {
                case "Playlist":
                    text += `${this.settings.get_string("loop-playlist")} `;
                    break;
                case "Track":
                    text += `${this.settings.get_string("loop-track")} `;
                    break;
                default:
                    break;
            }
            return text;
        }

        // many thanks to mheine's implementation
        showSpotify() {
            if (this._spotiWin && this._spotiWin.has_focus()) {
                // spotify is up and focused
                if (this._notSpotify) {
                    // hide spotify and pull up the last active window if possible
                    Main.activateWindow(this._notSpotify);
                }
            } else {
                // spotify is unfocused or the tray icon has never been clicked before
                this._spotiWin = this._notSpotify = null;
                let wins = global.get_window_actors(); // get all open windows
                for (let win of wins) {
                    if (typeof win.get_meta_window === "function") {
                        if (win.get_meta_window().get_wm_class() === "Spotify") {
                            this._spotiWin = win.get_meta_window(); // mark the spotify window
                        } else if (win.get_meta_window().has_focus()) {
                            this._notSpotify = win.get_meta_window(); // mark the window that was active when the button was pressed
                        }

                        if (this._spotiWin && this._notSpotify) {
                            break;
                        }
                    }
                }
                Main.activateWindow(this._spotiWin); // pull up the spotify window
            }
        }

        _pauseMarquee() {
            if (this.marqueeTimeoutId) {
                GLib.Source.remove(this.marqueeTimeoutId);
                this.marqueeTimeoutId = null;
            }
        }

        _stopMarquee() {
            this._pauseMarquee();
            this.marqueeGenerator = null;
        }
    },
);

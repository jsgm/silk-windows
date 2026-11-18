// SPDX-License-Identifier: MIT

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WobbleManager} from './wobble.js';

export default class SilkWindowsExtension extends Extension {
    enable() {
        this._wobble = new WobbleManager();
    }

    disable() {
        this._wobble.destroy();
        this._wobble = null;
    }
}

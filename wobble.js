// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

const MOVE_OPS = new Set([
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
    Meta.GrabOp.KEYBOARD_MOVING,
]);

// The deformation is a smooth low-order curve; a 5x5 grid is enough.
const TILES = 5;

// How much far content lags behind the pointer (1 = full motion).
const INTENSITY = 0.8;
// Damped spring in px and seconds: omega ~ 16 rad/s, damping ratio 0.32.
const STIFFNESS = 290 * 0.9;
const DAMPING = 2 * 0.32 * Math.sqrt(STIFFNESS);
const MAX_DT = 1 / 30;
// Jumps larger than this (snapping, unmaximizing) do not produce inertia.
const TELEPORT_SQ = 220 * 220;
const REST_POS = 0.2;
const REST_VEL = 4;

const WobbleEffect = GObject.registerClass(
class SilkWobbleEffect extends Clutter.DeformEffect {
    constructor() {
        super();
        this.set_n_tiles(TILES, TILES);
        // Offset of the point farthest from the grab point, in px.
        this.lagX = 0;
        this.lagY = 0;
        // Grab point in actor coordinates.
        this.grabX = 0;
        this.grabY = 0;
        // 1 / distance from the grab point to the farthest corner.
        this.invRadius = 0;
        // How far vertices may move outside the actor.
        this.margin = 0;
    }

    vfunc_deform_vertex(_width, _height, vertex) {
        const dx = vertex.x - this.grabX;
        const dy = vertex.y - this.grabY;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * this.invRadius);
        // Smoothstep keeps the grabbed area rigid while the edges sway.
        const weight = d * d * (3 - 2 * d);
        vertex.x += this.lagX * weight;
        vertex.y += this.lagY * weight;
    }

    vfunc_modify_paint_volume(volume) {
        const origin = volume.get_origin();
        origin.x -= this.margin;
        origin.y -= this.margin;
        volume.set_origin(origin);
        volume.set_width(volume.get_width() + 2 * this.margin);
        volume.set_height(volume.get_height() + 2 * this.margin);
        return super.vfunc_modify_paint_volume(volume);
    }
});

// Created on grab-op-begin, but the effect and the timeline only exist once
// the window has actually moved, so a click without dragging costs nothing.
class WobbleController {
    constructor(window, op, onDestroy) {
        this._window = window;
        this._actor = window.get_compositor_private();
        this._onDestroy = onDestroy;
        this._keyboard = op === Meta.GrabOp.KEYBOARD_MOVING;
        this._velX = 0;
        this._velY = 0;
        this._lastX = this._actor.x;
        this._lastY = this._actor.y;
        this.dragging = true;

        this._effect = null;
        this._timeline = null;
        this._newFrameId = null;
        this._positionChangedId = window.connect('position-changed', () => this._activate());
        this._actorDestroyId = this._actor.connect('destroy', () => this.destroy());
    }

    // Called on grab-op-end: a window that never moved is dropped right away,
    // otherwise it keeps swaying until the spring settles.
    release() {
        if (this._effect)
            this.dragging = false;
        else
            this.destroy();
    }

    regrab(op) {
        this.dragging = true;
        this._keyboard = op === Meta.GrabOp.KEYBOARD_MOVING;
        this._updateGeometry(true);
    }

    destroy() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline.disconnect(this._newFrameId);
            this._newFrameId = null;
            this._timeline = null;
        }
        if (this._positionChangedId) {
            this._window.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        this._actor.disconnect(this._actorDestroyId);
        this._actorDestroyId = null;

        if (this._effect) {
            this._actor.remove_effect(this._effect);
            this._effect = null;
        }
        this._onDestroy();

        this._actor = null;
        this._window = null;
        this._onDestroy = null;
    }

    _activate() {
        this._window.disconnect(this._positionChangedId);
        this._positionChangedId = null;

        this._effect = new WobbleEffect();
        this._updateGeometry(true);
        this._actor.add_effect(this._effect);

        // Driven by the actor's frame clock: one tick per refresh until the
        // spring settles after release.
        this._timeline = new Clutter.Timeline({actor: this._actor, duration: 60000, repeat_count: -1});
        this._newFrameId = this._timeline.connect('new-frame', () => this._tick());
        this._timeline.start();
    }

    _updateGeometry(updateGrab) {
        const {width, height} = this._actor;
        const effect = this._effect;
        this._width = width;
        this._height = height;

        if (updateGrab) {
            effect.grabX = width / 2;
            effect.grabY = height / 2;
            if (!this._keyboard) {
                const [px, py] = global.get_pointer();
                const [ok, x, y] = this._actor.transform_stage_point(px, py);
                if (ok) {
                    effect.grabX = Math.min(Math.max(x, 0), width);
                    effect.grabY = Math.min(Math.max(y, 0), height);
                }
            }
        }

        const farX = Math.max(effect.grabX, width - effect.grabX);
        const farY = Math.max(effect.grabY, height - effect.grabY);
        effect.invRadius = 1 / Math.max(1, Math.sqrt(farX * farX + farY * farY));

        this._maxLag = Math.min(70, 0.09 * Math.min(width, height) + 12) * INTENSITY;
        effect.margin = Math.ceil(this._maxLag) + 2;
    }

    _tick() {
        const dt = Math.min(this._timeline.get_delta() / 1000, MAX_DT);

        const effect = this._effect;
        const {x, y, width, height} = this._actor;
        let moveX = x - this._lastX;
        let moveY = y - this._lastY;
        this._lastX = x;
        this._lastY = y;

        // A resize (unmaximizing by drag, tiling on release) is treated like a
        // jump: no inertia, and the grab geometry is measured again.
        const resized = width !== this._width || height !== this._height;
        if (resized || moveX * moveX + moveY * moveY > TELEPORT_SQ) {
            moveX = moveY = 0;
            this._updateGeometry(this.dragging);
        }

        // Far content lags behind the grab point, then a semi-implicit Euler
        // step pulls it back (stable while omega * dt < 2).
        let lagX = effect.lagX - moveX * INTENSITY;
        let lagY = effect.lagY - moveY * INTENSITY;
        this._velX += (-STIFFNESS * lagX - DAMPING * this._velX) * dt;
        this._velY += (-STIFFNESS * lagY - DAMPING * this._velY) * dt;
        lagX += this._velX * dt;
        lagY += this._velY * dt;

        const len = Math.hypot(lagX, lagY);
        if (len > this._maxLag) {
            const s = this._maxLag / len;
            lagX *= s;
            lagY *= s;
            this._velX *= s;
            this._velY *= s;
        }

        const resting = Math.abs(lagX) < REST_POS && Math.abs(lagY) < REST_POS &&
            Math.abs(this._velX) < REST_VEL && Math.abs(this._velY) < REST_VEL;

        if (resting && !this.dragging) {
            this.destroy();
            return;
        }

        if (resting) {
            lagX = lagY = 0;
            this._velX = this._velY = 0;
        }

        // A held but motionless window needs no repaint.
        if (lagX === effect.lagX && lagY === effect.lagY)
            return;

        effect.lagX = lagX;
        effect.lagY = lagY;
        effect.invalidate();
    }
}

export class WobbleManager {
    constructor() {
        this._controllers = new Map();

        this._grabBeginId = global.display.connect('grab-op-begin',
            (_display, window, op) => this._onGrabBegin(window, op));
        this._grabEndId = global.display.connect('grab-op-end',
            (_display, window) => this._onGrabEnd(window));
    }

    destroy() {
        global.display.disconnect(this._grabBeginId);
        global.display.disconnect(this._grabEndId);
        this._grabBeginId = null;
        this._grabEndId = null;

        for (const controller of [...this._controllers.values()])
            controller.destroy();
        this._controllers.clear();
        this._controllers = null;
    }

    _onGrabBegin(window, op) {
        if (!MOVE_OPS.has(op) || window.is_fullscreen())
            return;

        const actor = window.get_compositor_private();
        const controller = this._controllers.get(actor);
        if (controller) {
            controller.regrab(op);
            return;
        }

        this._controllers.set(actor, new WobbleController(window, op,
            () => this._controllers.delete(actor)));
    }

    _onGrabEnd(window) {
        this._controllers.get(window.get_compositor_private())?.release();
    }
}

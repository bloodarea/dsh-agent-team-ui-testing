"""Draw the real Blender 3D editor on the private display, one frame per request."""
import json
import math
from pathlib import Path
from queue import Empty, SimpleQueue
import struct
import sys
from threading import Thread
import traceback
import zlib

import bpy
import gpu
from mathutils import Quaternion
import numpy as np


output = Path(sys.argv[sys.argv.index('--') + 1])
requests = SimpleQueue()


def reply(status):
    print('DSH_VIEWPORT ' + status, flush=True)


def read_requests():
    for line in sys.stdin:
        requests.put(json.loads(line))
    requests.put(None)


def png_chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data)))


def write_png(rgb):
    height, width, _ = rgb.shape
    rows = np.zeros((height, width * 3 + 1), dtype=np.uint8)
    rows[:, 1:] = rgb.reshape(height, width * 3)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    output.write_bytes(b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', header)
                       + png_chunk(b'IDAT', zlib.compress(rows.tobytes(), level=3))
                       + png_chunk(b'IEND', b''))


class Viewport:
    def __init__(self):
        self.window = bpy.context.window_manager.windows[0]
        self.area = next((area for area in self.window.screen.areas if area.type == 'VIEW_3D'), None)
        if self.area is None:
            self.area = max(self.window.screen.areas, key=lambda area: area.width * area.height)
            self.area.type = 'VIEW_3D'
        with bpy.context.temp_override(window=self.window, area=self.area):
            bpy.ops.screen.screen_full_area(use_hide_panels=True)
        self.area = next(area for area in self.window.screen.areas if area.type == 'VIEW_3D')
        self.space = self.area.spaces.active
        # Chrome is hidden so the capture contains the 3D editor alone. `show_region_asset_shelf`
        # is read-only whenever the UI is actually running (every GUI-mode launch, which is the
        # only mode where `gpu` exists) and writable in background mode; it is also absent before
        # 3.0. Both are runtime facts, not version facts, so each write is attempted defensively.
        for name in ('show_gizmo', 'show_region_toolbar', 'show_region_ui', 'show_region_header',
                     'show_region_tool_header', 'show_region_asset_shelf'):
            try:
                setattr(self.space, name, False)
            except (AttributeError, TypeError):
                pass
        self.space.overlay.show_text = False
        self.space.overlay.show_extras = False
        self.space.shading.type = 'SOLID'
        self.space.region_3d.view_perspective = 'PERSP'
        self.base_rotation = self.space.region_3d.view_rotation.copy()
        self.base_distance = self.space.region_3d.view_distance
        self.pending = None
        self.waiting_for_events = False
        self.mouse = (0, 0)
        self.buttons = set()
        self.drawn = False
        self.offscreen = None
        self.draw_handler = self.space.draw_handler_add(self.after_draw, (), 'WINDOW', 'POST_PIXEL')

    def after_draw(self):
        if bpy.context.area == self.area:
            self.drawn = True

    def render(self, width, height):
        region = next(region for region in self.area.regions if region.type == 'WINDOW')
        view = self.space.region_3d
        projection = view.window_matrix.copy()
        # Preserve the scene's proportions and keep the longest axis framing consistent.
        source_scale = max(region.width, region.height)
        output_scale = max(width, height)
        projection[0][0] *= (output_scale / width) / (source_scale / region.width)
        projection[1][1] *= (output_scale / height) / (source_scale / region.height)
        with bpy.context.temp_override(window=self.window, area=self.area, region=region):
            if self.offscreen is not None and (self.offscreen.width, self.offscreen.height) != (width, height):
                self.offscreen.free()
                self.offscreen = None
            if self.offscreen is None:
                self.offscreen = gpu.types.GPUOffScreen(width, height)
            self.offscreen.draw_view3d(bpy.context.scene, bpy.context.view_layer, self.space,
                                       region, view.view_matrix, projection,
                                       do_color_management=True, draw_background=True)
            with self.offscreen.bind():
                frame = gpu.state.active_framebuffer_get()
                pixels = frame.read_color(0, 0, width, height, 4, 0, 'UBYTE')
                pixels.dimensions = width * height * 4
                rgba = np.asarray(pixels, dtype=np.uint8).reshape(height, width, 4)
                write_png(rgba[::-1, :, :3])

    def dispatch_input(self, events):
        button_types = ('LEFTMOUSE', 'MIDDLEMOUSE', 'RIGHTMOUSE')
        for event in events:
            kind = event['kind']
            if kind in ('cancel', 'escape'):
                x, y = self.mouse
                if kind == 'escape':
                    for value in ('PRESS', 'RELEASE'):
                        self.window.event_simulate(type='ESC', value=value, x=x, y=y)
                for button in sorted(self.buttons):
                    self.window.event_simulate(type=button_types[button], value='RELEASE', x=x, y=y)
                self.buttons.clear()
                continue

            x = min(self.window.width - 1, int(event['x'] * self.window.width))
            y = self.window.height - 1 - min(self.window.height - 1, int(event['y'] * self.window.height))
            self.mouse = (x, y)
            position = dict(x=x, y=y, shift=event['shift'], ctrl=event['ctrl'], alt=event['alt'])
            # Native UI handlers use the cursor position for hit testing and menu placement.
            self.window.event_simulate(type='MOUSEMOVE', value='NOTHING', **position)
            if kind in ('down', 'up'):
                button = event['button']
                if kind == 'down' and button not in self.buttons:
                    self.buttons.add(button)
                    self.window.event_simulate(type=button_types[button], value='PRESS', **position)
                elif kind == 'up' and button in self.buttons:
                    self.buttons.remove(button)
                    self.window.event_simulate(type=button_types[button], value='RELEASE', **position)
            elif kind == 'wheel':
                delta = event['delta']
                event_type = 'WHEELDOWNMOUSE' if delta > 0 else 'WHEELUPMOUSE'
                for _ in range(abs(delta)):
                    self.window.event_simulate(type=event_type, value='PRESS', **position)

    def capture_window(self, width, height):
        # Blender composites the popup and the 3D editor into the same native window.
        native = output.with_name('native.png')
        with bpy.context.temp_override(window=self.window):
            result = bpy.ops.screen.screenshot(filepath=str(native))
        if 'FINISHED' not in result:
            raise RuntimeError('Blender could not capture its window')
        with native.open('rb') as stream:
            source_width, source_height = struct.unpack('>II', stream.read(24)[16:24])
        if (source_width, source_height) == (width, height):
            native.replace(output)
            return (0, 0, width, height)
        scale = min(width / source_width, height / source_height)
        fitted_width = max(1, round(source_width * scale))
        fitted_height = max(1, round(source_height * scale))
        left = (width - fitted_width) // 2
        top = (height - fitted_height) // 2
        image = bpy.data.images.load(str(native), check_existing=False)
        try:
            image.scale(fitted_width, fitted_height)
            pixels = np.empty(fitted_width * fitted_height * 4, dtype=np.float32)
            image.pixels.foreach_get(pixels)
            rgb = np.rint(pixels.reshape(fitted_height, fitted_width, 4)[::-1, :, :3] * 255).astype(np.uint8)
            canvas = np.zeros((height, width, 3), dtype=np.uint8)
            canvas[top:top + fitted_height, left:left + fitted_width] = rgb
            write_png(canvas)
        finally:
            bpy.data.images.remove(image)
        return (left, top, fitted_width, fitted_height)

    def tick(self):
        try:
            if self.waiting_for_events:
                # Simulated input is handled by Blender's event loop after the timer returns.
                self.waiting_for_events = False
                self.drawn = False
                self.area.tag_redraw()
                return 0.02
            if self.pending is not None and self.drawn:
                request = self.pending
                self.pending = None
                if 'input' in request:
                    content = self.capture_window(*request['size'])
                    reply('frame ' + ' '.join(map(str, content)))
                else:
                    self.render(*request['size'])
                    reply('frame')
            if self.pending is None:
                request = requests.get_nowait()
                if request is None:
                    bpy.ops.wm.quit_blender()
                    return None
                if isinstance(request, list):
                    request = {'camera': request, 'size': (960, 540)}
                if 'input' in request:
                    events = request['input']
                    if request.get('generation') is None and self.buttons:
                        events = [{'kind': 'cancel'}]
                    self.dispatch_input(events)
                    self.waiting_for_events = bool(events)
                else:
                    yaw, pitch, scale = request['camera']
                    view = self.space.region_3d
                    view.view_rotation = (Quaternion((0, 0, 1), math.radians(yaw)) @ self.base_rotation
                                          @ Quaternion((1, 0, 0), math.radians(pitch)))
                    view.view_distance = self.base_distance * scale
                self.drawn = False
                self.pending = request
                self.area.tag_redraw()
        except Empty:
            pass
        except Exception:
            traceback.print_exc()
            self.pending = None
            reply('error')
        return 0.02


def start():
    try:
        viewport = Viewport()
        Thread(target=read_requests, daemon=True).start()
        bpy.app.timers.register(viewport.tick)
        print(f'DSH_VIEWPORT {bpy.app.version_string}', flush=True)
    except Exception:
        traceback.print_exc()
        reply('error')


bpy.context.preferences.view.show_splash = False
bpy.context.preferences.view.use_save_prompt = False
bpy.context.preferences.filepaths.temporary_directory = str(output.parent)
bpy.context.preferences.filepaths.use_auto_save_temporary_files = False
bpy.app.timers.register(start, first_interval=0.1)

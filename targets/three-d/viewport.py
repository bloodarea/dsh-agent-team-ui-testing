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


def png_chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data)))


def capture_region(offscreen):
    width, height = offscreen.width, offscreen.height
    frame = gpu.state.active_framebuffer_get()
    pixels = frame.read_color(0, 0, width, height, 4, 0, 'UBYTE')
    pixels.dimensions = width * height * 4
    rgba = np.asarray(pixels, dtype=np.uint8).reshape(height, width, 4)
    rows = np.zeros((height, width * 3 + 1), dtype=np.uint8)
    rows[:, 1:] = rgba[::-1, :, :3].reshape(height, width * 3)
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
        self.pending_size = None
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
                capture_region(self.offscreen)

    def tick(self):
        try:
            if self.pending_size and self.drawn:
                self.render(*self.pending_size)
                self.pending_size = None
                reply('frame')
            if self.pending_size is None:
                request = requests.get_nowait()
                # A running Host may still send the earlier camera-only protocol during reload.
                camera, size = (request, (960, 540)) if isinstance(request, list) else (request['camera'], request['size'])
                yaw, pitch, scale = camera
                view = self.space.region_3d
                view.view_rotation = (Quaternion((0, 0, 1), math.radians(yaw)) @ self.base_rotation
                                      @ Quaternion((1, 0, 0), math.radians(pitch)))
                view.view_distance = self.base_distance * scale
                self.drawn = False
                self.pending_size = size
                self.area.tag_redraw()
        except Empty:
            pass
        except Exception:
            traceback.print_exc()
            self.pending_size = None
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
bpy.app.timers.register(start, first_interval=0.1)

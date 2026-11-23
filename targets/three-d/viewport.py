"""Draw the real Blender 3D editor on the private display, one frame per request."""
from itertools import groupby
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

# The plugin directory is a source or installed bundle, not a bytecode cache.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
from editor_windows import EditorWindows, WindowPointer, screenshot
from workspaces import WorkspaceDeck


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
        self.workspaces = WorkspaceDeck(self.window)
        self.setup = self.activate_workspace('layout')
        self.area = None
        self.space = None
        self.pending = None
        self.pointer = WindowPointer(self.window)
        self.editors = EditorWindows(self.window)
        self.drawn = False
        self.offscreen = None
        self.draw_handler = bpy.types.SpaceView3D.draw_handler_add(self.after_draw, (), 'WINDOW', 'POST_PIXEL')

    def find_main_view(self):
        areas = (area for area in self.window.screen.areas if area.type == 'VIEW_3D')
        self.area = max(areas, key=lambda area: area.width * area.height, default=None)
        self.space = self.area.spaces.active if self.area else None

    def bind_workspace(self):
        self.find_main_view()
        if self.workspaces.current != 'layout' or self.space is None:
            return
        if hasattr(self, 'base_rotation'):
            return
        self.space.shading.type = 'SOLID'
        self.space.region_3d.view_perspective = 'PERSP'
        self.base_rotation = self.space.region_3d.view_rotation.copy()
        self.base_distance = self.space.region_3d.view_distance

    def activate_workspace(self, workspace):
        yield from self.workspaces.activate(workspace)
        self.bind_workspace()

    def redraw(self):
        self.drawn = False
        for area in self.window.screen.areas:
            area.tag_redraw()
        if self.pending is not None:
            self.editors.redraw(self.pending.get('editors', ()))

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

    def capture_window(self, width, height):
        # Blender composites the popup and the 3D editor into the same native window.
        native = output.with_name('native.png')
        screenshot(self.window, native)
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

    def apply_request(self, request):
        interactive = 'input' in request
        workspace = request.get('workspace') if interactive else 'layout'
        if workspace and workspace != self.workspaces.current:
            self.pointer.dispatch([{'kind': 'escape'}])
            for name in self.editors.visible:
                self.editors.pointers[name].dispatch([{'kind': 'escape'}])
            yield
            yield from self.activate_workspace(workspace)

        if not interactive:
            yaw, pitch, scale = request['camera']
            view = self.space.region_3d
            view.view_rotation = (Quaternion((0, 0, 1), math.radians(yaw)) @ self.base_rotation
                                  @ Quaternion((1, 0, 0), math.radians(pitch)))
            view.view_distance = self.base_distance * scale
            return

        names = request.get('editors', ())
        yield from self.editors.prepare(names)
        if self.editors.sync(names):
            yield

        shading = request.get('shading')
        if shading is not None:
            if self.space is None:
                raise RuntimeError('This workspace has no 3D editor')
            self.space.shading.type = shading

        events = request['input']
        if request.get('generation') is None:
            if self.pointer.buttons:
                events = [{'kind': 'cancel'}]
            for name in names:
                if self.editors.pointers[name].buttons:
                    events = [*events, {'kind': 'cancel', 'editor': name}]
        # Blender drains each window's queue separately. Yield between target changes
        # so events still take effect in the request's order across windows.
        for name, batch in groupby(events, key=lambda event: event.get('editor')):
            pointer = self.pointer if name is None else self.editors.pointers[name]
            pointer.dispatch(batch)
            yield
        if events:
            self.find_main_view()
            if self.editors.sync(names):
                yield

    def advance_setup(self):
        try:
            next(self.setup)
        except StopIteration:
            self.setup = None
            self.redraw()

    def tick(self):
        try:
            if self.setup is not None:
                self.advance_setup()
                return 0.02
            if self.pending is not None and (self.area is None or self.drawn):
                request = self.pending
                self.pending = None
                if 'input' in request:
                    content = self.capture_window(*request['size'])
                    self.editors.capture(request.get('editors', ()), output)
                    shading = self.space.shading.type if self.space else 'NONE'
                    reply('frame ' + ' '.join(map(str, (*content, shading, self.workspaces.current))))
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
                self.pending = request
                self.setup = self.apply_request(request)
                self.advance_setup()
        except Empty:
            pass
        except Exception:
            traceback.print_exc()
            self.pending = None
            self.setup = None
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

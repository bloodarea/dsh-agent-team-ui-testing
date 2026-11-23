"""Native Blender editor windows owned by the isolated viewport window."""
import struct
import zlib

import bpy
import numpy as np

from display_settings import DisplaySettings, SETTINGS, sidebar_bounds
from workspaces import hide_editor_chrome


PREFERENCES = 'preferences'
TIMELINE = 'timeline'
EDITOR_SIZES = {'outliner': (360, 300), 'properties': (380, 620), TIMELINE: (960, 84),
                **{name: size for name, (size, _panel) in SETTINGS.items()}}


def png_chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data)))


def write_png(path, rgb):
    height, width, _ = rgb.shape
    rows = np.zeros((height, width * 3 + 1), dtype=np.uint8)
    rows[:, 1:] = rgb.reshape(height, width * 3)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', header)
                     + png_chunk(b'IDAT', zlib.compress(rows.tobytes(), level=3))
                     + png_chunk(b'IEND', b''))


class WindowPointer:
    def __init__(self, window):
        self.window = window
        self.mouse = (0, 0)
        self.buttons = set()
        self.bounds = None

    def dispatch(self, events):
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

            left, bottom, width, height = self.bounds or (0, 0, self.window.width, self.window.height)
            x = left + min(width - 1, int(event['x'] * width))
            y = bottom + height - 1 - min(height - 1, int(event['y'] * height))
            position = dict(x=x, y=y, shift=event['shift'], ctrl=event['ctrl'], alt=event['alt'])
            # Native handlers use the cursor for hit testing. Replaying a stationary move
            # on release can dismiss a nested color or thumbnail picker in the sidebar.
            if self.bounds is None or kind == 'move' or self.mouse != (x, y):
                self.window.event_simulate(type='MOUSEMOVE', value='NOTHING', **position)
            self.mouse = (x, y)
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


def screenshot(window, path):
    with bpy.context.temp_override(window=window):
        if 'FINISHED' not in bpy.ops.screen.screenshot(filepath=str(path)):
            raise RuntimeError('Blender could not capture its window')


def screenshot_region(window, path, bounds):
    native = path.with_name(f'native-{path.name}')
    screenshot(window, native)
    image = bpy.data.images.load(str(native), check_existing=False)
    try:
        left, bottom, width, height = bounds
        source_width, source_height = image.size
        pixels = np.empty(source_width * source_height * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        rgba = pixels.reshape(source_height, source_width, 4)
        rgb = rgba[bottom:bottom + height, left:left + width, :3][::-1]
        write_png(path, np.rint(rgb * 255).astype(np.uint8))
    finally:
        bpy.data.images.remove(image)
        native.unlink()


def open_child(window, area, prefer_full_window=False):
    windows = bpy.context.window_manager.windows
    before = {item.as_pointer() for item in windows}
    with bpy.context.temp_override(window=window, area=area):
        if prefer_full_window and bpy.ops.wm.window_new.poll():
            result = bpy.ops.wm.window_new()
        else:
            result = bpy.ops.screen.area_dupli('INVOKE_DEFAULT')
    if 'FINISHED' not in result:
        raise RuntimeError('Blender could not open its editor window')
    child, = (item for item in windows if item.as_pointer() not in before)
    return child


def split(window, area, direction, factor):
    with bpy.context.temp_override(window=window, area=area):
        if 'FINISHED' not in bpy.ops.screen.area_split(direction=direction, factor=factor):
            raise RuntimeError('Blender could not size its editor area')


class EditorWindows:
    def __init__(self, main):
        self.main = main
        self.settings = DisplaySettings(main)
        self.pointers = {}
        self.visible = set()

    def is_playing(self, name):
        return name in self.visible and self.pointers[name].window.screen.is_animation_playing

    def dismiss(self, name):
        pointer = self.pointers[name]
        if name == TIMELINE and self.is_playing(name):
            with bpy.context.temp_override(window=pointer.window):
                bpy.ops.screen.animation_cancel(restore_frame=False)
        pointer.dispatch([{'kind': 'escape'}])

    def prepare(self, names):
        dismissed = self.visible.difference(names)
        for name in dismissed:
            self.dismiss(name)
            self.visible.remove(name)
        if dismissed:
            yield
        for name in names:
            if name not in self.pointers:
                yield from self.create(name)
            self.visible.add(name)

    def create(self, name):
        if name == PREFERENCES:
            windows = bpy.context.window_manager.windows
            before = {item.as_pointer() for item in windows}
            with bpy.context.temp_override(window=self.main):
                if 'FINISHED' not in bpy.ops.screen.userpref_show():
                    raise RuntimeError('Blender could not open its preferences window')
            yield
            window, = (item for item in windows if item.as_pointer() not in before
                       and any(area.type == 'PREFERENCES' for area in item.screen.areas))
            bpy.context.preferences.active_section = 'ADDONS'
            self.pointers[name] = WindowPointer(window)
            yield
            return

        width, height = EDITOR_SIZES[name]
        source = max(self.main.screen.areas, key=lambda area: min(area.width / width, area.height / height))
        # Window dimensions are read-only in Blender. Size a disposable window, leaving
        # the main screen intact, then detach the correctly sized area as a sibling.
        scratch = open_child(self.main, source, prefer_full_window=len(self.main.screen.areas) > 1)
        try:
            yield
            area, = scratch.screen.areas
            scale = min(1.0, area.width / width, area.height / height)
            width *= scale
            height *= scale
            if area.width - width >= 64:
                split(scratch, area, 'VERTICAL', width / area.width)
                yield
                area = min(scratch.screen.areas, key=lambda item: item.x)
            if area.height - height >= 64:
                split(scratch, area, 'HORIZONTAL', height / area.height)
                yield
                area = min(scratch.screen.areas, key=lambda item: (item.x, item.y))
            window = open_child(scratch, area)
        finally:
            with bpy.context.temp_override(window=scratch):
                if 'FINISHED' not in bpy.ops.wm.window_close():
                    raise RuntimeError('Blender could not close its temporary window')
        yield

        area, = window.screen.areas
        if name == TIMELINE and area.height - height >= 64:
            # The detached window can be taller than requested due to OS minimum sizing.
            split(window, area, 'HORIZONTAL', height / area.height)
            yield
            area, spare = sorted(window.screen.areas, key=lambda item: item.y)
            spare.type = 'IMAGE_EDITOR'
        settings = name in SETTINGS
        area.ui_type = 'VIEW_3D' if settings else name.upper()
        yield
        hide_editor_chrome(area)
        if name == TIMELINE:
            area.spaces.active.show_region_header = True
        if settings:
            yield from self.settings.prepare(name, window, area)
        self.pointers[name] = WindowPointer(window)
        yield

    def dispatch(self, name, events):
        pointer = self.pointers[name]
        if name in SETTINGS and (self.settings.area is None or pointer.bounds is None):
            return
        pointer.dispatch(events)

    def sync(self, names):
        changed = False
        for name in names:
            window = self.pointers[name].window
            if window.scene != self.main.scene:
                window.scene = self.main.scene
                changed = True
            if window.view_layer != self.main.view_layer:
                window.view_layer = self.main.view_layer
                changed = True
        return changed

    def redraw(self, names):
        for name in names:
            for area in self.pointers[name].window.screen.areas:
                area.tag_redraw()

    def capture(self, names, output):
        for name in names:
            pointer = self.pointers[name]
            path = output.with_name(f'editor-{name}.png')
            if name in SETTINGS:
                area, = pointer.window.screen.areas
                pointer.bounds = sidebar_bounds(area)
                screenshot_region(pointer.window, path, pointer.bounds)
            elif name == TIMELINE:
                area = next(area for area in pointer.window.screen.areas if area.ui_type == 'TIMELINE')
                pointer.bounds = (area.x, area.y, area.width, area.height)
                screenshot_region(pointer.window, path, pointer.bounds)
            else:
                screenshot(pointer.window, path)

"""Native Blender editor windows owned by the isolated viewport window."""
import bpy

from workspaces import hide_editor_chrome


EDITOR_SIZES = {'outliner': (360, 300), 'properties': (380, 620)}


class WindowPointer:
    def __init__(self, window):
        self.window = window
        self.mouse = (0, 0)
        self.buttons = set()

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

            width, height = self.window.width, self.window.height
            x = min(width - 1, int(event['x'] * width))
            y = height - 1 - min(height - 1, int(event['y'] * height))
            self.mouse = (x, y)
            position = dict(x=x, y=y, shift=event['shift'], ctrl=event['ctrl'], alt=event['alt'])
            # Native handlers use the cursor position for hit testing and popup placement.
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


def screenshot(window, path):
    with bpy.context.temp_override(window=window):
        if 'FINISHED' not in bpy.ops.screen.screenshot(filepath=str(path)):
            raise RuntimeError('Blender could not capture its window')


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
        self.pointers = {}
        self.visible = set()

    def prepare(self, names):
        dismissed = self.visible.difference(names)
        for name in dismissed:
            self.pointers[name].dispatch([{'kind': 'escape'}])
            self.visible.remove(name)
        if dismissed:
            yield
        for name in names:
            if name not in self.pointers:
                yield from self.create(name)
            self.visible.add(name)

    def create(self, name):
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
        area.type = name.upper()
        yield
        hide_editor_chrome(area)
        self.pointers[name] = WindowPointer(window)
        yield

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
            screenshot(self.pointers[name].window, output.with_name(f'editor-{name}.png'))

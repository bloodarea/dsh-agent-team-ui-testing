"""Build the panel's editor layouts on Blender's native workspace screens."""
import bpy


# Editor order is left to right, then top to bottom. Split factors are measured
# from the left or bottom edge, as in Blender's area_split operator.
WORKSPACES = {
    'layout': ('Layout', ('VIEW_3D',)),
    'modeling': ('Modeling', ('VIEW_3D',)),
    'sculpting': ('Sculpting', ('VIEW_3D',)),
    'uv-editing': ('UV Editing', ('UV', 'VIEW_3D')),
    'texture-paint': ('Texture Paint', ('IMAGE_EDITOR', 'VIEW_3D')),
    'shading': ('Shading', ('VIEW_3D', 'ShaderNodeTree')),
    'animation': ('Animation', ('VIEW_3D', 'VIEW_3D', 'DOPESHEET')),
    'rendering': ('Rendering', ('IMAGE_EDITOR',)),
    'compositing': ('Compositing', ('IMAGE_EDITOR', 'CompositorNodeTree')),
}


def hide_editor_chrome(area):
    space = area.spaces.active
    # Blender exposes a different set of region flags for each editor and mode.
    for name in ('show_region_tool_header', 'show_region_header', 'show_region_footer',
                 'show_region_toolbar', 'show_region_ui', 'show_region_hud',
                 'show_region_channels', 'show_region_asset_shelf', 'show_gizmo'):
        try:
            setattr(space, name, False)
        except (AttributeError, TypeError):
            pass
    if area.type == 'VIEW_3D':
        space.overlay.show_text = False
        space.overlay.show_extras = False


def area_position(area):
    return (-area.y, area.x)


class WorkspaceDeck:
    def __init__(self, window):
        self.window = window
        self.current = None
        self.prepared = set()

    def activate(self, key):
        name, editors = WORKSPACES[key]
        workspace = bpy.data.workspaces.get(name)
        if workspace is None:
            # A supplied blend can omit the factory workspaces. Duplicate its current
            # workspace so the existing scene and the other editor layouts survive.
            original = {item.as_pointer() for item in bpy.data.workspaces}
            with bpy.context.temp_override(window=self.window):
                if 'FINISHED' not in bpy.ops.workspace.duplicate():
                    raise RuntimeError(f'Cannot create workspace {name}')
            yield
            workspace = next(item for item in bpy.data.workspaces if item.as_pointer() not in original)
            workspace.name = name
        if self.window.workspace != workspace:
            self.window.workspace = workspace
            yield
        if self.window.workspace != workspace:
            raise RuntimeError(f'Cannot activate workspace {name}')
        if key not in self.prepared:
            yield from self.prepare(key, editors)
            self.prepared.add(key)
        self.current = key

    def prepare(self, key, editors):
        screen = self.window.screen
        keep = next((area for area in screen.areas if area.ui_type == editors[0]), None)
        if keep is None:
            keep = max(screen.areas, key=lambda area: area.width * area.height)
        while len(screen.areas) > 1:
            # Close side panels first. If a junction cannot be closed, try the next area.
            areas = sorted((area for area in screen.areas if area != keep), key=lambda area: area.width * area.height)
            for area in areas:
                with bpy.context.temp_override(window=self.window, area=area):
                    if bpy.ops.screen.area_close.poll() and 'FINISHED' in bpy.ops.screen.area_close():
                        break
            else:
                raise RuntimeError(f'Cannot simplify screen {screen.name}')
            yield

        base = screen.areas[0]
        if len(editors) == 1:
            base.ui_type = editors[0]
            if key == 'layout':
                with bpy.context.temp_override(window=self.window, area=base):
                    if 'FINISHED' not in bpy.ops.screen.screen_full_area(use_hide_panels=True):
                        raise RuntimeError(f'Cannot expand screen {screen.name}')
                yield
        else:
            if key in ('uv-editing', 'texture-paint'):
                yield from self.split(base, 'VERTICAL', 0.5)
            elif key == 'animation':
                yield from self.split(base, 'HORIZONTAL', 0.42)
                top = max(screen.areas, key=lambda area: area.y)
                yield from self.split(top, 'VERTICAL', 0.355)
            else:
                yield from self.split(base, 'HORIZONTAL', 0.5)
            areas = sorted(screen.areas, key=area_position)
            if len(areas) != len(editors):
                raise RuntimeError(f'Unexpected editor count in {screen.name}')
            for area, editor in zip(areas, editors):
                if area.ui_type != editor:
                    area.ui_type = editor
            if key == 'animation':
                areas[0].spaces.active.region_3d.view_perspective = 'CAMERA'
                right = areas[1].spaces.active
                right.region_3d.view_perspective = 'PERSP'
                right.overlay.show_overlays = True

        if key == 'rendering':
            result = bpy.data.images.get('Render Result')
            if result is not None:
                self.window.screen.areas[0].spaces.active.image = result
        # Wait for the new space and workspace mode before writing mode-dependent flags.
        yield
        for area in self.window.screen.areas:
            hide_editor_chrome(area)
            if area.type == 'VIEW_3D':
                # Leave the native Gizmos popover enabled with the initial viewport uncluttered.
                space = area.spaces.active
                space.show_gizmo = True
                space.show_gizmo_navigate = False
                space.show_gizmo_tool = False
                space.show_gizmo_modifier = False
                space.show_gizmo_context = False
            area.tag_redraw()
        yield

    def split(self, area, direction, factor):
        with bpy.context.temp_override(window=self.window, area=area):
            if 'FINISHED' not in bpy.ops.screen.area_split(direction=direction, factor=factor):
                raise RuntimeError(f'Cannot split screen {self.window.screen.name}')
        yield

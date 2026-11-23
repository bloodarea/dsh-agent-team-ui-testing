"""Blender's viewport popover panels, hosted in separate native sidebars."""
import bpy
from bl_ui import space_view3d


SETTINGS = {
    'select-visibility': ((340, 460), space_view3d.VIEW3D_PT_object_type_visibility),
    'gizmos': ((340, 500), space_view3d.VIEW3D_PT_gizmo_display),
    'overlays': ((370, 620), space_view3d.VIEW3D_PT_overlay),
    'shading-settings': ((550, 530), space_view3d.VIEW3D_PT_shading),
}

CATEGORY = 'Viewport Settings'
_windows = {}
_registered = False


class MainViewContext:
    def __init__(self, context, area):
        self.context = context
        self.space_data = area.spaces.active

    def __getattr__(self, name):
        return getattr(self.context, name)


class DSH_OT_viewport_matcap_flip(bpy.types.Operator):
    bl_idname = 'dsh.viewport_matcap_flip'
    bl_label = 'Flip MatCap'
    bl_description = 'Flip MatCap horizontally'

    def execute(self, context):
        binding = _windows.get(context.window.as_pointer())
        if binding is None:
            return {'CANCELLED'}
        settings, _name = binding
        area = settings.area
        if area is None:
            return {'CANCELLED'}
        region = next(region for region in area.regions if region.type == 'WINDOW')
        with bpy.context.temp_override(window=settings.main, area=area, region=region):
            return bpy.ops.view3d.toggle_matcap_flip()


class MatcapLayout:
    """Preserve the native layout and route its viewport operator to the main area."""
    def __init__(self, layout):
        object.__setattr__(self, '_layout', layout)

    def __getattr__(self, name):
        return getattr(self._layout, name)

    def __setattr__(self, name, value):
        setattr(self._layout, name, value)

    def row(self, **kwargs):
        return MatcapLayout(self._layout.row(**kwargs))

    def column(self, **kwargs):
        return MatcapLayout(self._layout.column(**kwargs))

    def split(self, **kwargs):
        return MatcapLayout(self._layout.split(**kwargs))

    def operator(self, name, **kwargs):
        if name == 'view3d.toggle_matcap_flip':
            name = DSH_OT_viewport_matcap_flip.bl_idname
        return self._layout.operator(name, **kwargs)


class LightingPanel:
    def __init__(self, panel):
        self.layout = MatcapLayout(panel.layout)


def panel_callback(native, method, root):
    def draw(self, context):
        settings, _name = _windows[context.window.as_pointer()]
        if settings.area is None:
            if root:
                self.layout.label(text='No 3D viewport in this workspace', icon='INFO')
            return
        panel = LightingPanel(self) if native is space_view3d.VIEW3D_PT_shading_lighting else self
        getattr(native, method)(panel, MainViewContext(context, settings.area))

    return draw


def register_panel(native, name, parent=None):
    @classmethod
    def poll(cls, context):
        binding = _windows.get(context.window.as_pointer())
        if binding is None or binding[1] != name:
            return False
        area = binding[0].area
        if parent is None:
            return True
        native_poll = getattr(native, 'poll', None)
        return area is not None and (native_poll is None or native_poll(MainViewContext(context, area)))

    native_options = set(getattr(native, 'bl_options', ()))
    if parent is None:
        native_options.add('HIDE_HEADER')
    attrs = {
        'bl_region_type': 'UI',
        'bl_category': CATEGORY,
        'bl_parent_id': parent or '',
        'bl_options': native_options,
        'poll': poll,
        'draw': panel_callback(native, 'draw', parent is None),
    }
    for method in ('draw_header', 'draw_header_preset'):
        if method in native.__dict__:
            attrs[method] = panel_callback(native, method, False)
    panel_id = f'DSH_PT_{native.__name__}'
    bpy.utils.register_class(type(panel_id, (native,), attrs))
    for child in space_view3d.classes:
        if getattr(child, 'bl_parent_id', None) == native.__name__:
            register_panel(child, name, panel_id)


class DisplaySettings:
    def __init__(self, main):
        self.main = main
        self.area = None

    def prepare(self, name, window, area):
        global _registered
        if not _registered:
            bpy.utils.register_class(DSH_OT_viewport_matcap_flip)
            for editor, (_size, root) in SETTINGS.items():
                register_panel(root, editor)
            _registered = True

        _windows[window.as_pointer()] = (self, name)
        space = area.spaces.active
        space.shading.type = 'SOLID'
        space.shading.background_type = 'THEME'
        space.overlay.show_overlays = False
        # The native sidebar can be translucent. Empty its own view without changing the scene.
        for prop in space.bl_rna.properties:
            if prop.identifier.startswith('show_object_viewport_'):
                setattr(space, prop.identifier, False)
        space.show_region_ui = True
        area.tag_redraw()
        yield
        region = sidebar(area)
        if hasattr(region, 'active_panel_category'):
            region.active_panel_category = CATEGORY
        # Drag the native sidebar divider to give controls the available window width.
        if region.x > area.x + 1:
            x, y = region.x, region.y + region.height // 2
            window.event_simulate(type='MOUSEMOVE', value='NOTHING', x=x, y=y)
            window.event_simulate(type='LEFTMOUSE', value='PRESS', x=x, y=y)
            yield
            window.event_simulate(type='MOUSEMOVE', value='NOTHING', x=area.x + 1, y=y)
            window.event_simulate(type='LEFTMOUSE', value='RELEASE', x=area.x + 1, y=y)
            yield
        area.tag_redraw()
        yield


def sidebar(area):
    return next(region for region in area.regions if region.type == 'UI')


def sidebar_bounds(area):
    region = sidebar(area)
    # Blender reserves a strip about one UI unit wide for sidebar category tabs.
    tabs = round(21 * bpy.context.preferences.system.ui_scale)
    return (region.x, region.y, region.width - tabs, region.height)

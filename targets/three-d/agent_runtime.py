"""Closed Blender main-thread command surface used by viewport.py."""
import bpy
import math
import hashlib
import json
from pathlib import Path
from mathutils import Quaternion

SUPPORTED_OPS = {
    'collection.ensure', 'object.ensure', 'object.parent', 'object.transform',
    'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign',
}


def _fail(message):
    raise ValueError(message)


def _exact(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        _fail('invalid fields')


def _identifier(value, *prefixes):
    if not isinstance(value, str) or len(value) > 64 or not any(value.startswith(prefix) for prefix in prefixes):
        _fail('invalid stable id')
    suffix = value.split('_', 1)[1]
    if not suffix or not all(c.isascii() and (c.isalnum() or c == '_') for c in suffix):
        _fail('invalid stable id')
    return value


def _managed(item, scene_id):
    if item.get('dsh.managed_by') != 'dsh-agent' or item.get('dsh.scene_id') != scene_id:
        _fail('object is not managed by this scene')


def _find_object(scene_id, stable_id):
    matches = [item for item in bpy.data.objects if item.get('dsh.stable_id') == stable_id]
    if len(matches) > 1:
        _fail('duplicate stable id')
    if matches and (matches[0].get('dsh.managed_by') != 'dsh-agent' or matches[0].get('dsh.scene_id') != scene_id):
        _fail('stable id is owned by another object or scene')
    return matches[0] if matches else None


def _collection(scene_id):
    collection = bpy.data.collections.get('DSH::' + scene_id)
    if collection is None:
        collection = bpy.data.collections.new('DSH::' + scene_id)
        bpy.context.scene.collection.children.link(collection)
    if collection.get('dsh.managed_by') not in (None, 'dsh-agent') or collection.get('dsh.scene_id') not in (None, scene_id):
        _fail('managed collection collision')
    collection['dsh.managed_by'], collection['dsh.scene_id'] = 'dsh-agent', scene_id
    return collection


def _content_hash(item):
    """Digest the managed local geometry, transform, hierarchy and material bindings."""
    mesh = item.data if item.type == 'MESH' else None
    content = {
        'version': 1, 'type': item.type, 'name': item.name,
        'stableId': item.get('dsh.stable_id'), 'sceneId': item.get('dsh.scene_id'),
        'parentId': item.parent.get('dsh.stable_id') if item.parent else None,
        'matrixBasis': [list(row) for row in item.matrix_basis],
        'vertices': [list(vertex.co) for vertex in mesh.vertices] if mesh else [],
        'edges': [list(edge.vertices) for edge in mesh.edges] if mesh else [],
        'faces': [{'vertices': list(face.vertices), 'materialIndex': face.material_index} for face in mesh.polygons] if mesh else [],
        'materials': [material.name if material else None for material in mesh.materials] if mesh else [],
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def _stamp_content_hash(item):
    digest = _content_hash(item)
    item['dsh.content_hash'] = digest
    return digest


def _material_socket(node, identifier):
    # Node/socket display names are localized; identifiers are stable in Blender 5.3.
    socket = next((s for s in node.inputs if s.identifier == identifier), None)
    if socket is None:
        _fail(f'no input identifier {identifier!r} on {node.bl_idname}; '
              f'found identifiers: {[s.identifier for s in node.inputs]!r}')
    return socket


def _op(op_id, args):
    allowed = {'collection.ensure', 'object.ensure', 'object.parent', 'object.transform', 'mesh.primitive',
               'object.remove', 'material.ensure', 'material.assign'}
    if op_id not in allowed:
        _fail('unsupported operation')
    scene_id = _identifier(args.get('sceneId'), 'scn_')
    if op_id == 'collection.ensure':
        _exact(args, ('sceneId',))
        return {'collection': _collection(scene_id).name}
    if op_id == 'object.ensure':
        _exact(args, ('sceneId', 'stableId', 'label', 'kind'))
        stable_id = _identifier(args['stableId'], 'obj_', 'part_')
        if args['kind'] != 'empty' or not isinstance(args['label'], str) or not args['label']:
            _fail('invalid object.ensure arguments')
        item = _find_object(scene_id, stable_id)
        if item is not None and item.type != 'EMPTY':
            _fail('managed object type mismatch')
        if item is None:
            item = bpy.data.objects.new(args['label'], None)
            _collection(scene_id).objects.link(item)
        item.name = args['label']
        item['dsh.managed_by'], item['dsh.scene_id'], item['dsh.stable_id'] = 'dsh-agent', scene_id, stable_id
        return {'stableId': stable_id, 'name': item.name, 'contentHash': _stamp_content_hash(item)}
    if op_id == 'object.parent':
        _exact(args, ('sceneId', 'childId', 'parentId'))
        child_id = _identifier(args['childId'], 'obj_', 'part_')
        child = _find_object(scene_id, child_id)
        if child is None:
            _fail('child not found')
        parent_id = args['parentId']
        parent = None if parent_id is None else _find_object(scene_id, _identifier(parent_id, 'obj_', 'part_'))
        if parent_id is not None and parent is None:
            _fail('parent not found')
        cursor = parent
        while cursor is not None:
            if cursor == child:
                _fail('parent cycle')
            cursor = cursor.parent
        child.parent = parent
        child.matrix_parent_inverse.identity()
        return {'childId': child_id, 'parentId': parent_id, 'contentHash': _stamp_content_hash(child)}
    if op_id == 'object.transform':
        _exact(args, ('sceneId', 'stableId', 'translation', 'rotation', 'scale'))
        stable_id = _identifier(args['stableId'], 'obj_', 'part_')
        item = _find_object(scene_id, stable_id)
        translation, rotation, scale = args['translation'], args['rotation'], args['scale']
        if item is None or not all(isinstance(v, list) and len(v) == n for v, n in ((translation, 3), (rotation, 4), (scale, 3))):
            _fail('invalid transform target')
        values = translation + rotation + scale
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values) or any(v <= 0 for v in scale):
            _fail('invalid transform values')
        if abs(sum(v*v for v in rotation) - 1) > 1e-4:
            _fail('rotation must be a unit quaternion')
        item.location = translation
        item.rotation_mode = 'QUATERNION'
        item.rotation_quaternion = rotation
        item.scale = scale
        return {'stableId': stable_id, 'contentHash': _stamp_content_hash(item)}
    if op_id == 'mesh.primitive':
        _exact(args, ('sceneId', 'stableId', 'shape'))
        stable_id, shape = _identifier(args['stableId'], 'part_'), args['shape']
        if not isinstance(shape, dict) or shape.get('kind') not in ('box', 'cylinder', 'frustum'):
            _fail('unsupported primitive')
        kind = shape['kind']
        if kind == 'box':
            _exact(shape, ('kind', 'size'))
            size = shape['size']
            if not isinstance(size, list) or len(size) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in size):
                _fail('invalid box size')
            vertices = [(x*size[0]/2, y*size[1]/2, z*size[2]/2) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
            faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        else:
            _exact(shape, ('kind', 'radius', 'height', 'segments') if kind == 'cylinder' else ('kind', 'bottomRadius', 'topRadius', 'height', 'segments'))
            segments = shape['segments']
            bottom = shape['radius'] if kind == 'cylinder' else shape['bottomRadius']
            top, height = (bottom if kind == 'cylinder' else shape['topRadius']), shape['height']
            if not isinstance(segments, int) or not 3 <= segments <= 256 or not isinstance(height, (int, float)) or not math.isfinite(height) or height <= 0 or not all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in (bottom, top)) or max(bottom, top) <= 0:
                _fail('invalid primitive dimensions')
            vertices = [(radius*math.cos(2*math.pi*i/segments), radius*math.sin(2*math.pi*i/segments), z)
                        for radius, z in ((bottom, -height/2), (top, height/2)) for i in range(segments)]
            faces = [tuple(reversed(range(segments))), tuple(range(segments, 2*segments))]
            faces += [(i, (i+1) % segments, (i+1) % segments + segments, i + segments) for i in range(segments)]
        mesh = bpy.data.meshes.new(stable_id)
        mesh.from_pydata(vertices, [], faces)
        item = _find_object(scene_id, stable_id)
        if item is not None and item.type != 'MESH':
            bpy.data.meshes.remove(mesh)
            _fail('managed object type mismatch')
        if item is None:
            item = bpy.data.objects.new(stable_id, mesh)
            _collection(scene_id).objects.link(item)
        else:
            old_mesh = item.data
            item.data = mesh
            if old_mesh.users == 0:
                bpy.data.meshes.remove(old_mesh)
        item['dsh.managed_by'], item['dsh.scene_id'], item['dsh.stable_id'] = 'dsh-agent', scene_id, stable_id
        return {'stableId': stable_id, 'vertices': len(mesh.vertices), 'faces': len(mesh.polygons), 'contentHash': _stamp_content_hash(item)}
    if op_id == 'object.remove':
        _exact(args, ('sceneId', 'stableId', 'expectedManagedHash', 'cascadeIds'))
        stable_id = _identifier(args['stableId'], 'obj_', 'part_')
        item = _find_object(scene_id, stable_id)
        cascade = args['cascadeIds']
        if (item is None or not isinstance(args['expectedManagedHash'], str)
                or not args['expectedManagedHash'] or item.get('dsh.content_hash') != args['expectedManagedHash']
                or _content_hash(item) != args['expectedManagedHash']
                or not isinstance(cascade, list) or len(set(cascade)) != len(cascade)):
            _fail('invalid remove request or managed hash mismatch')
        children = list(item.children_recursive)
        if {child.get('dsh.stable_id') for child in children} != set(cascade):
            _fail('cascade ids do not match current children')
        targets = [item] + children
        for target in targets:
            _managed(target, scene_id)
        for target in reversed(targets):
            bpy.data.objects.remove(target, do_unlink=True)
        return {'removedIds': [stable_id] + cascade}
    if op_id == 'material.ensure':
        _exact(args, ('sceneId', 'stableId', 'label'), ('roughness', 'metallic', 'opacity', 'baseColorLinear'))
        stable_id = _identifier(args['stableId'], 'mat_')
        material = next((m for m in bpy.data.materials if m.get('dsh.scene_id') == scene_id and m.get('dsh.stable_id') == stable_id and m.get('dsh.managed_by') == 'dsh-agent'), None)
        if material is None:
            material = bpy.data.materials.new(args['label'])
        material['dsh.managed_by'], material['dsh.scene_id'], material['dsh.stable_id'] = 'dsh-agent', scene_id, stable_id
        material.use_nodes = True
        nodes = material.node_tree.nodes
        shader = next((n for n in nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled'), None)
        if shader is None:
            _fail(f'no ShaderNodeBsdfPrincipled node; found types: {[n.bl_idname for n in nodes]!r}')
        for key, identifier in (('roughness', 'Roughness'), ('metallic', 'Metallic'), ('opacity', 'Alpha')):
            if key in args:
                value = args[key]
                if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                    _fail('invalid material value')
                _material_socket(shader, identifier).default_value = value
        if 'baseColorLinear' in args:
            color = args['baseColorLinear']
            if not isinstance(color, list) or len(color) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in color):
                _fail('invalid material color')
            _material_socket(shader, 'Base Color').default_value = (*color, 1)
        return {'stableId': stable_id, 'name': material.name}
    if op_id == 'material.assign':
        _exact(args, ('sceneId', 'targetStableId', 'materialId', 'slot'))
        target_id, material_id, slot = args['targetStableId'], _identifier(args['materialId'], 'mat_'), args['slot']
        target = _find_object(scene_id, _identifier(target_id, 'part_'))
        material = next((m for m in bpy.data.materials if m.get('dsh.managed_by') == 'dsh-agent' and m.get('dsh.scene_id') == scene_id and m.get('dsh.stable_id') == material_id), None)
        if target is None or target.type != 'MESH' or material is None or not isinstance(slot, int) or not 0 <= slot <= 255:
            _fail('invalid material assignment')
        while len(target.data.materials) <= slot:
            target.data.materials.append(None)
        target.data.materials[slot] = material
        return {'targetStableId': target_id, 'materialId': material_id, 'slot': slot, 'contentHash': _stamp_content_hash(target)}
    _fail('unsupported operation')


class AgentRuntime:
    def __init__(self, viewport):
        self.viewport = viewport

    def execute(self, request):
        _exact(request, ('channel', 'id', 'targetId', 'generation', 'runtimeGeneration', 'op', 'payload'))
        if (request['channel'] != 'command' or not isinstance(request['id'], str) or not request['id']
                or not isinstance(request['targetId'], str) or not request['targetId']
                or not ((isinstance(request['generation'], int) and not isinstance(request['generation'], bool) and request['generation'] > 0)
                        or (isinstance(request['generation'], str) and 0 < len(request['generation']) <= 128))
                or not isinstance(request['runtimeGeneration'], str) or len(request['runtimeGeneration']) != 32):
            _fail('invalid command identity')
        op, payload = request.get('op'), request.get('payload')
        if not isinstance(payload, dict):
            _fail('payload must be an object')
        if op == 'hello':
            _exact(payload, ())
            return {'version': bpy.app.version_string, 'supportedOps': sorted({'collection.ensure', 'object.ensure', 'object.parent', 'object.transform', 'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign'})}
        if op == 'scene.query':
            _exact(payload, (), ('ids', 'limit'))
            ids, limit = payload.get('ids'), payload.get('limit', 1000)
            if ids is not None and (not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(i, str) for i in ids)) or not isinstance(limit, int) or not 1 <= limit <= 1000:
                _fail('invalid query')
            objects = [obj for obj in bpy.data.objects if obj.get('dsh.managed_by') == 'dsh-agent' and (ids is None or obj.get('dsh.stable_id') in ids)][:limit]
            return {'objects': [{'stableId': obj.get('dsh.stable_id'), 'name': obj.name, 'type': obj.type, 'parentId': obj.parent.get('dsh.stable_id') if obj.parent else None, 'location': list(obj.location), 'scale': list(obj.scale)} for obj in objects]}
        if op == 'scene.apply':
            _exact(payload, ('ops',))
            ops = payload['ops']
            if not isinstance(ops, list) or not 1 <= len(ops) <= 32:
                _fail('invalid operation batch')
            return {'results': [_op(item['opId'], item['args']) for item in ops if isinstance(item, dict) and set(item) == {'opId', 'args'} and isinstance(item['args'], dict)]} if all(isinstance(item, dict) and set(item) == {'opId', 'args'} and isinstance(item['args'], dict) for item in ops) else _fail('invalid operation batch')
        if op == 'project.save':
            _exact(payload, ())
            project = self.viewport.project_path
            if not project or not project.lower().endswith('.blend') or Path(bpy.data.filepath).resolve() != Path(project).resolve():
                _fail('project save is not bound to the active project')
            if 'FINISHED' not in bpy.ops.wm.save_as_mainfile(filepath=project, check_existing=False, compress=True):
                _fail('project save failed')
            return {'saved': True}
        if op in ('view.get', 'view.set'):
            if op == 'view.get':
                _exact(payload, ())
            else:
                _exact(payload, ('changes',))
                _exact(payload['changes'], (), ('rotation', 'distance', 'projection'))
                if not payload['changes']:
                    _fail('empty view changes')
            view = self.viewport.space.region_3d if self.viewport.space else None
            if view is None:
                _fail('3D view is unavailable')
            if op == 'view.set':
                changes = payload['changes']
                if 'rotation' in changes:
                    value = changes['rotation']
                    if not isinstance(value, list) or len(value) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value) or abs(sum(v*v for v in value) - 1) > 1e-4:
                        _fail('invalid view rotation')
                    view.view_rotation = Quaternion(value)
                if 'distance' in changes:
                    value = changes['distance']
                    if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.15 <= value <= 10000:
                        _fail('invalid view distance')
                    view.view_distance = value
                if 'projection' in changes:
                    if changes['projection'] not in ('PERSP', 'ORTHO', 'CAMERA'):
                        _fail('invalid projection')
                    view.view_perspective = changes['projection']
            return {'rotation': list(view.view_rotation), 'distance': view.view_distance, 'projection': view.view_perspective}
        _fail('unsupported command')

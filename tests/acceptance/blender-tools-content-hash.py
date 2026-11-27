"""Exercise actual closed operation functions with a minimal bpy data fixture; no Blender launch."""
import ast
import hashlib
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'targets/three-d/agent_runtime.py'


class Managed(dict):
    def __init__(self, name, mesh=None):
        super().__init__()
        self.name = name
        self.data = mesh
        self.type = 'MESH' if mesh else 'EMPTY'
        self.parent = None
        self.children_recursive = []
        self.matrix_basis = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
        self.matrix_parent_inverse = SimpleNamespace(identity=lambda: None)
        self._scale = [1, 1, 1]
        self._location = [0, 0, 0]
        self._rotation = [1, 0, 0, 0]

    @property
    def scale(self):
        return self._scale

    @scale.setter
    def scale(self, value):
        self._scale = value
        for i in range(3):
            self.matrix_basis[i][i] = value[i]

    @property
    def location(self):
        return self._location

    @location.setter
    def location(self, value):
        self._location = value
        for i in range(3):
            self.matrix_basis[i][3] = value[i]

    @property
    def rotation_quaternion(self):
        return self._rotation

    @rotation_quaternion.setter
    def rotation_quaternion(self, value):
        self._rotation = value


class Mesh:
    users = 0

    def __init__(self):
        self.vertices, self.edges, self.polygons, self.materials = [], [], [], []

    def from_pydata(self, vertices, edges, faces):
        self.vertices = [SimpleNamespace(co=list(vertex)) for vertex in vertices]
        self.edges = [SimpleNamespace(vertices=edge) for edge in edges]
        self.polygons = [SimpleNamespace(vertices=face, material_index=0) for face in faces]


class Objects(list):
    def new(self, name, mesh):
        result = Managed(name, mesh)
        self.append(result)
        return result

    def remove(self, item, do_unlink=False):
        super().remove(item)


class HashTests(unittest.TestCase):
    def setUp(self):
        self.objects = Objects()
        self.material = Managed('Paint')
        self.material.update({'dsh.managed_by': 'dsh-agent', 'dsh.scene_id': 'scn_test', 'dsh.stable_id': 'mat_paint'})
        namespace = {'math': math, 'json': json, 'hashlib': hashlib,
                     'bpy': SimpleNamespace(data=SimpleNamespace(objects=self.objects, meshes=SimpleNamespace(new=lambda _name: Mesh(), remove=lambda _mesh: None), materials=[self.material]))}
        tree = ast.parse(RUNTIME.read_text(encoding='utf-8'))
        names = {'_fail', '_exact', '_identifier', '_managed', '_find_object', '_content_hash', '_stamp_content_hash', '_op'}
        nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(RUNTIME), 'exec'), namespace)
        namespace['_collection'] = lambda _scene: SimpleNamespace(objects=SimpleNamespace(link=lambda _item: None))
        self.op, self.hash = namespace['_op'], namespace['_content_hash']

    def primitive(self):
        result = self.op('mesh.primitive', {'sceneId': 'scn_test', 'stableId': 'part_test', 'shape': {'kind': 'box', 'size': [1, 2, 3]}})
        item = next(item for item in self.objects if item.type == 'MESH')
        self.assertEqual(result['contentHash'], item['dsh.content_hash'])
        self.assertEqual(item['dsh.content_hash'], self.hash(item))
        return item, result['contentHash']

    def remove(self, digest):
        return self.op('object.remove', {'sceneId': 'scn_test', 'stableId': 'part_test', 'expectedManagedHash': digest, 'cascadeIds': []})

    def test_created_primitive_has_reproducible_hash_and_positive_remove(self):
        item, digest = self.primitive()
        self.assertRegex(digest, r'^[a-f0-9]{64}$')
        self.assertEqual(self.hash(item), digest)
        self.assertEqual(self.remove(digest), {'removedIds': ['part_test']})
        self.assertEqual(len(self.objects), 0)

    def test_wrong_expected_hash_and_external_mesh_edit_cannot_delete(self):
        item, digest = self.primitive()
        with self.assertRaisesRegex(ValueError, 'managed hash mismatch'):
            self.remove('f' * 64)
        item.data.vertices[0].co[0] += 0.1
        self.assertEqual(item['dsh.content_hash'], digest)
        with self.assertRaisesRegex(ValueError, 'managed hash mismatch'):
            self.remove(digest)
        self.assertEqual(len(self.objects), 1)

    def test_transform_and_assignment_refresh_digest_and_old_receipts_fail(self):
        item, before = self.primitive()
        changed = self.op('object.transform', {'sceneId': 'scn_test', 'stableId': 'part_test', 'translation': [1, 0, 0], 'rotation': [1, 0, 0, 0], 'scale': [2, 1, 1]})
        self.assertNotEqual(changed['contentHash'], before)
        with self.assertRaisesRegex(ValueError, 'managed hash mismatch'):
            self.remove(before)
        assigned = self.op('material.assign', {'sceneId': 'scn_test', 'targetStableId': 'part_test', 'materialId': 'mat_paint', 'slot': 0})
        self.assertNotEqual(assigned['contentHash'], changed['contentHash'])
        self.assertEqual(assigned['contentHash'], self.hash(item))
        self.assertEqual(self.remove(assigned['contentHash'])['removedIds'], ['part_test'])

    def test_empty_object_and_parent_write_are_stamped(self):
        empty = self.op('object.ensure', {'sceneId': 'scn_test', 'stableId': 'obj_parent', 'label': 'Parent', 'kind': 'empty'})
        self.assertEqual(empty['contentHash'], self.hash(self.objects[0]))
        self.primitive()
        child = next(item for item in self.objects if item.type == 'MESH')
        result = self.op('object.parent', {'sceneId': 'scn_test', 'childId': 'part_test', 'parentId': 'obj_parent'})
        self.assertEqual(result['contentHash'], self.hash(child))


if __name__ == '__main__':
    unittest.main(verbosity=2)

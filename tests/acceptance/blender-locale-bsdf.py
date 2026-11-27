"""Guard material.ensure against localized display-name lookups; no bpy required."""
import ast
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'targets/three-d/agent_runtime.py'
SOCKET_IDS = ('Roughness', 'Metallic', 'Alpha', 'Base Color')


def display_name_lookups(source):
    """Reject keyed node/socket access, including indirect socket-name variables."""
    def node_or_socket_collection(node):
        return ((isinstance(node, ast.Attribute) and node.attr in ('nodes', 'inputs'))
                or (isinstance(node, ast.Name) and node.id in ('nodes', 'inputs')))

    violations = []
    for node in ast.walk(ast.parse(source)):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'get' and node_or_socket_collection(node.func.value)):
            violations.append(f'line {node.lineno}: {ast.unparse(node)}')
        if (isinstance(node, ast.Subscript) and node_or_socket_collection(node.value)
                and not (isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, int))):
            violations.append(f'line {node.lineno}: {ast.unparse(node)}')
    return violations


class IterationOnly(list):
    def get(self, *args):
        raise AssertionError('display-name get is forbidden')

    def __getitem__(self, key):
        raise AssertionError('keyed node/socket access is forbidden')


class Material(dict):
    def __init__(self, name, localized):
        super().__init__()
        self.name = name
        self.use_nodes = True
        names = ('糙度', '金属度', 'Alpha', '基础色') if localized else SOCKET_IDS
        sockets = IterationOnly(SimpleNamespace(identifier=identifier, name=display_name,
                                               default_value=(0.8, 0.8, 0.8, 1) if identifier == 'Base Color' else 0.5)
                                for identifier, display_name in zip(SOCKET_IDS, names))
        self.shader = SimpleNamespace(bl_idname='ShaderNodeBsdfPrincipled',
                                      name='原理化 BSDF' if localized else 'Principled BSDF', inputs=sockets)
        self.node_tree = SimpleNamespace(nodes=IterationOnly([
            SimpleNamespace(bl_idname='ShaderNodeOutputMaterial', name='材质输出'), self.shader]))


class Materials(list):
    def __init__(self, localized):
        super().__init__()
        self.localized = localized

    def new(self, name):
        material = Material(name, self.localized)
        self.append(material)
        return material


class LocaleBsdfTests(unittest.TestCase):
    def runtime(self, localized=True):
        materials = Materials(localized)
        namespace = {'math': math, 'bpy': SimpleNamespace(data=SimpleNamespace(materials=materials))}
        names = {'_fail', '_exact', '_identifier', '_material_socket', '_op'}
        tree = ast.parse(RUNTIME.read_text(encoding='utf-8'))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(RUNTIME), 'exec'), namespace)
        return namespace['_op'], materials

    def ensure(self, op, **values):
        return op('material.ensure', {'sceneId': 'scn_locale', 'stableId': 'mat_test', 'label': 'Paint', **values})

    def test_runtime_avoids_display_name_lookups(self):
        self.assertEqual(display_name_lookups(RUNTIME.read_text(encoding='utf-8')), [])

    def test_guard_catches_literal_and_indirect_display_name_lookups(self):
        for source in ("material.node_tree.nodes.get('Principled BSDF')",
                       'material.node_tree.nodes.get("原理化 BSDF")',
                       "shader.inputs['Roughness']", 'shader.inputs["Base Color"]',
                       'shader.inputs[socket]', "shader.inputs.get('Alpha')",
                       "nodes.get('Principled BSDF')", "inputs['Roughness']"):
            with self.subTest(source=source):
                self.assertTrue(display_name_lookups(source))
        self.assertEqual(display_name_lookups("next(s for s in shader.inputs if s.identifier == 'Roughness')"), [])

    def test_english_and_chinese_display_names_write_identical_values(self):
        for localized in (False, True):
            with self.subTest(localized=localized):
                op, materials = self.runtime(localized)
                result = self.ensure(op, roughness=0.6, metallic=0.2, opacity=0.7, baseColorLinear=[0.1, 0.2, 0.3])
                self.assertEqual(result, {'stableId': 'mat_test', 'name': 'Paint'})
                values = {s.identifier: s.default_value for s in materials[0].shader.inputs}
                self.assertEqual(values, {'Roughness': 0.6, 'Metallic': 0.2, 'Alpha': 0.7, 'Base Color': (0.1, 0.2, 0.3, 1)})

    def test_omitted_fields_preserve_existing_values_and_material(self):
        op, materials = self.runtime()
        self.ensure(op, roughness=0.6, metallic=0.2, opacity=0.7, baseColorLinear=[0.1, 0.2, 0.3])
        before = {s.identifier: s.default_value for s in materials[0].shader.inputs}
        self.ensure(op)
        self.assertEqual(len(materials), 1)
        self.assertEqual(before, {s.identifier: s.default_value for s in materials[0].shader.inputs})
        self.ensure(op, roughness=0)
        after = {s.identifier: s.default_value for s in materials[0].shader.inputs}
        self.assertEqual(after, {**before, 'Roughness': 0})

    def test_missing_principled_reports_actual_node_types(self):
        op, materials = self.runtime()
        self.ensure(op)
        materials[0].node_tree.nodes.remove(materials[0].shader)
        with self.assertRaisesRegex(ValueError, 'no ShaderNodeBsdfPrincipled node; found types:.*ShaderNodeOutputMaterial'):
            self.ensure(op, roughness=0.6)

    def test_missing_socket_reports_identifier_and_available_identifiers(self):
        op, materials = self.runtime()
        self.ensure(op)
        inputs = materials[0].shader.inputs
        inputs.remove(next(s for s in inputs if s.identifier == 'Roughness'))
        inputs.append(SimpleNamespace(identifier='Unexpected', name='Roughness', default_value=0.5))
        with self.assertRaisesRegex(ValueError, 'Roughness.*ShaderNodeBsdfPrincipled.*found identifiers:.*Metallic'):
            self.ensure(op, roughness=0.6)

    def test_normalized_scalar_validation_and_boundaries_are_preserved(self):
        op, _materials = self.runtime()
        for key in ('roughness', 'metallic', 'opacity'):
            for value in (-0.1, 1.1, math.inf, math.nan, '0.5'):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, 'invalid material value'):
                    self.ensure(op, **{key: value})
            for value in (0, 1):
                self.ensure(op, **{key: value})

    def test_linear_rgb_validation_is_preserved(self):
        op, _materials = self.runtime()
        for color in ([0, 0], [0, 0, 0, 1], [-0.1, 0, 0], [1.1, 0, 0], [math.nan, 0, 0], ['0', 0, 0]):
            with self.subTest(color=color), self.assertRaisesRegex(ValueError, 'invalid material color'):
                self.ensure(op, baseColorLinear=color)


if __name__ == '__main__':
    unittest.main(verbosity=2)

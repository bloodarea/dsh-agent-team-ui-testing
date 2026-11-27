"""Run the real viewport tick and object.remove refusal in isolation; never import bpy or launch Blender."""
import ast
import json
import math
from pathlib import Path
from queue import Queue, Empty
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load_function(path, name, namespace, class_name=None):
    tree = ast.parse(path.read_text(encoding='utf-8'))
    scope = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name).body if class_name else tree.body
    node = next(node for node in scope if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), namespace)
    return namespace[name]


class QueueDispatchTests(unittest.TestCase):
    def fixture(self, request, command_error=False):
        requests = Queue()
        requests.put(request)
        replies, applied, commands, rendered = [], [], [], []
        def execute(value):
            commands.append(value)
            if command_error:
                raise ValueError('refused fixture')
            return {'version': '5.3.0'}
        namespace = {'requests': requests, 'Empty': Empty, 'json': json, 'print': lambda message, **_kwargs: replies.append(message),
                     'bpy': SimpleNamespace(ops=SimpleNamespace(wm=SimpleNamespace(quit_blender=lambda: None))),
                     'traceback': SimpleNamespace(print_exc=lambda: None)}
        load_function(ROOT / 'targets/three-d/viewport.py', 'reply', namespace)
        tick = load_function(ROOT / 'targets/three-d/viewport.py', 'tick', namespace, 'Viewport')
        class Instance:
            setup = None
            pending = None
            area = None
            drawn = False
            agent_runtime = SimpleNamespace(execute=execute)
            def advance_setup(self):
                self.setup = None
            def apply_request(self, value):
                applied.append(value)
                if 'camera' not in value:
                    raise KeyError('camera')
                return iter(())
            def render(self, *size):
                rendered.append(size)
        instance = Instance()
        instance.tick = lambda: tick(instance)
        return instance, replies, applied, commands, rendered

    def test_new_command_dispatches_before_frame_path(self):
        for op in ('hello', 'scene.apply', 'scene.query'):
            request = {'channel': 'command', 'id': 'test', 'targetId': 'target_test', 'generation': 1,
                       'runtimeGeneration': 'a' * 32, 'op': op, 'payload': {}}
            instance, replies, applied, commands, _ = self.fixture(request)
            self.assertEqual(instance.tick(), 0.02)
            self.assertEqual(commands, [request])
            self.assertEqual(applied, [])
            self.assertIsNone(instance.pending)
            response = json.loads(replies[0].removeprefix('DSH_VIEWPORT command '))
            self.assertTrue(response['ok'])
            self.assertEqual(response['channel'], 'command-reply')
            for field in ('id', 'targetId', 'generation', 'runtimeGeneration'):
                self.assertEqual(response[field], request[field])

    def test_command_error_is_typed_reply_not_frame_error(self):
        request = {'channel': 'command', 'id': 'test', 'targetId': 'target_test', 'generation': 1,
                   'runtimeGeneration': 'a' * 32, 'op': 'hello', 'payload': {}}
        instance, replies, applied, commands, _ = self.fixture(request, command_error=True)
        instance.tick()
        response = json.loads(replies[0].removeprefix('DSH_VIEWPORT command '))
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], 'BLENDER_COMMAND_FAILED')
        self.assertEqual(applied, [])
        self.assertEqual(len(commands), 1)

    def test_legacy_list_and_frame_requests_keep_frame_behavior(self):
        for request in ([0, 0, 1], {'camera': [0, 0, 1], 'size': [960, 540]}):
            instance, replies, applied, commands, rendered = self.fixture(request)
            instance.tick()
            self.assertEqual(applied[0]['camera'], [0, 0, 1])
            self.assertEqual(commands, [])
            instance.tick()
            self.assertEqual(rendered, [(960, 540)])
            self.assertEqual(replies, ['DSH_VIEWPORT frame'])

    def test_remove_without_matching_managed_hash_remains_refused(self):
        path = ROOT / 'targets/three-d/agent_runtime.py'
        namespace = {'math': math}
        for name in ('_fail', '_exact', '_identifier'):
            load_function(path, name, namespace)
        namespace['_find_object'] = lambda *_args: {'dsh.managed_by': 'dsh-agent'}
        operation = load_function(path, '_op', namespace)
        with self.assertRaisesRegex(ValueError, 'managed hash mismatch'):
            operation('object.remove', {'sceneId': 'scn_test', 'stableId': 'obj_test',
                                       'expectedManagedHash': 'a' * 64, 'cascadeIds': []})


if __name__ == '__main__':
    unittest.main(verbosity=2)

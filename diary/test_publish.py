import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
import subprocess

import publish
from PIL import Image


def state(world='player-20261101'):
    return {
        'worldId': world, 'updatedAt': datetime.now(timezone.utc).isoformat(),
        'phase': 'survival', 'objective': 'Find shelter', 'longTerm': 'Reach the End',
        'serverVersion': 'Java 26.3', 'milestones': [], 'events': [],
        'bots': [{'name': 'Roy', 'health': 20, 'food': 18, 'status': 'online',
                  'task': 'Gather wood', 'inventory': []}],
    }


def narrative(world='player-20261101'):
    return {'worldId': world, 'text': 'I found a foothold, though the night worries me.',
            'model': 'gpt-6.1-terra', 'answerEntryId': 'answer-42'}


def capture(command, **kwargs):
    Image.new('RGB', (640, 360), '#add8e6').save(command[-1])


class PublishTests(unittest.TestCase):
    def publish_in(self, root, current, previous=None, response=None):
        output = root / 'public'
        output.mkdir(exist_ok=True)
        state_path = root / 'state.json'
        state_path.write_text(json.dumps(current))
        if previous is not None:
            (output / 'data.json').write_text(json.dumps(previous))
        with patch('publish.narrate', return_value=response or narrative()) as generate:
            with patch('publish.subprocess.run', side_effect=capture):
                publish.publish(state_path, output, root / 'capture.mjs')
        return json.loads((output / 'data.json').read_text()), generate.call_args.args[0]

    def test_new_world_archives_history_and_resets_event_window(self):
        previous = {'entries': [{'observedAt': '2026-11-01T12:00:00Z',
                                 'summary': 'Old expedition', 'image': 'images/old.webp'}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, context = self.publish_in(root, state(), previous)
            self.assertEqual(context['since'], '')
            self.assertEqual(context['worldId'], state()['worldId'])
            self.assertEqual(len(data['entries']), 1)
            self.assertEqual(data['entries'][0]['worldId'], state()['worldId'])
            archived = root / 'public/archives/legacy-expedition/data.json'
            self.assertEqual(json.loads(archived.read_text()), previous)
            self.assertEqual(data['archives'], [{'worldId': 'legacy-expedition',
                                               'path': 'archives/legacy-expedition/data.json'}])
            self.assertTrue((root / 'public' / data['entries'][0]['image']).exists())
            # A second publication retains same-world entries and the archive index.
            next_data, next_context = self.publish_in(root, state())
            self.assertEqual(next_context['since'], data['entries'][0]['observedAt'])
            self.assertEqual(len(next_data['entries']), 2)
            self.assertEqual(next_data['archives'], data['archives'])
            self.assertEqual(json.loads(archived.read_text()), previous)

    def test_next_world_preserves_all_prior_archives(self):
        previous = {'worldId': 'previous-world', 'archives': [
            {'worldId': 'legacy-expedition', 'path': 'archives/legacy-expedition/data.json'}
        ], 'entries': [{'observedAt': '2026-11-01T12:00:00Z', 'summary': 'Previous world'}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, _ = self.publish_in(root, state(), previous)
            self.assertEqual(len(data['archives']), 2)
            self.assertEqual(json.loads((root / 'public/archives/previous-world/data.json').read_text()), previous)

    def test_mismatched_narrative_and_model_failure_leave_history_untouched(self):
        for result in [narrative('wrong-world'), RuntimeError('Terra failed')]:
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root / 'public'
                output.mkdir()
                old = '{"entries": [{"summary": "Keep me"}]}'
                (output / 'data.json').write_text(old)
                path = root / 'state.json'
                path.write_text(json.dumps(state()))
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch('publish.narrate', **kwargs), patch('publish.subprocess.run') as frame:
                    with self.assertRaises((ValueError, RuntimeError)):
                        publish.publish(path, output, root / 'capture.mjs')
                    frame.assert_not_called()
                self.assertEqual((output / 'data.json').read_text(), old)
                self.assertFalse((output / 'archives').exists())

    def test_stale_observations_and_missing_or_unsafe_identity_are_rejected(self):
        cases = [state(), state('../outside'), state()]
        cases[0]['updatedAt'] = '2020-01-01T00:00:00Z'
        del cases[2]['worldId']
        for current in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'state.json'
                path.write_text(json.dumps(current))
                with patch('publish.narrate') as generate:
                    with self.assertRaises((RuntimeError, ValueError, KeyError)):
                        publish.publish(path, root / 'public', root / 'capture.mjs')
                    generate.assert_not_called()

    def test_failed_capture_keeps_narrative_without_reusing_previous_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'state.json'
            path.write_text(json.dumps(state()))
            with patch('publish.narrate', return_value=narrative()):
                with patch('publish.subprocess.run', side_effect=subprocess.TimeoutExpired('node', 65)):
                    with self.assertRaisesRegex(RuntimeError, 'camera error'):
                        publish.publish(path, root / 'public', root / 'capture.mjs')
            entry = json.loads((root / 'public/data.json').read_text())['entries'][0]
            self.assertIsNone(entry['image'])
            self.assertIn('failed', entry['captureError'])
            self.assertEqual(entry['summary'], narrative()['text'])
            self.assertEqual(entry['author'], 'gpt-6.1-terra')

    def test_only_observed_results_since_previous_snapshot_enter_context(self):
        current = state()
        def event(at, kind, message, data=None):
            return {'at': f'2026-11-01T12:{at}Z', 'bot': 'Roy', 'type': kind,
                    'message': message, 'data': data or {}}
        current['events'] = [
            event('14:59', 'death', 'Old death'),
            event('15:03', 'gather', 'Mined iron_ore at (1, 2, 3).'),
            event('15:04', 'mission', 'Build a grand house'),
            event('15:05', 'action', 'Placed a chest', {'verified': True}),
            event('15:06', 'action', 'I intend to finish the roof'),
            event('15:07', 'eat', 'Ate cooked beef', {'verified': True}),
            event('15:08', 'eat', 'Attempted meal'),
            event('15:09', 'craft', 'Crafted', {'item': 'stone_sword', 'count': 1}),
            event('15:10', 'build', 'Placed log', {'verified': True, 'material': 'oak_log'}),
            event('15:11', 'build', 'Placed air', {'verified': True, 'material': 'minecraft:air'}),
        ]
        facts = publish.diary_context(current, '2026-11-01T12:15:00Z')['facts']
        self.assertEqual(facts, [
            'Roy: Mined 1 iron ore; inventory pickup is tracked separately.',
            'Roy: Placed a chest', 'Roy: Ate cooked beef', 'Roy: Crafted 1 stone_sword.',
            'Roy: Placed one verified oak_log block; this does not establish a finished house.',
        ])

    def test_bad_or_undersized_camera_images_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frame.webp'
            Image.new('RGB', (100, 100)).save(path)
            with self.assertRaisesRegex(ValueError, 'too small'):
                publish.validate_frame(path)
            path.write_bytes(b'not an image')
            with self.assertRaises(OSError):
                publish.validate_frame(path)


if __name__ == '__main__':
    unittest.main()

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
import subprocess

import publish
from PIL import Image


class PublishTests(unittest.TestCase):
    def test_stale_observation_cannot_be_published_as_current(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state.json'
            state.write_text(json.dumps({'updatedAt': '2020-01-01T00:00:00Z'}))
            with patch('publish.subprocess.run') as capture:
                with self.assertRaisesRegex(RuntimeError, 'stale'):
                    publish.publish(state, root / 'public', root / 'capture.mjs')
                capture.assert_not_called()
            self.assertFalse((root / 'public' / 'data.json').exists())

    @patch('publish.narrate', return_value={'text': 'A subjective diary paragraph.', 'model': 'gpt-6.1-terra', 'answerEntryId': 'test-entry'})
    def test_failed_capture_publishes_explicit_error_not_previous_image(self, narrative):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state.json'
            state.write_text(json.dumps({
                'updatedAt': datetime.now(timezone.utc).isoformat(),
                'phase': 'equipment', 'objective': 'Find jern',
                'longTerm': 'Dragen', 'serverVersion': 'Java 26.3',
                'bots': [], 'milestones': [], 'events': [],
            }))
            with patch('publish.subprocess.run', side_effect=subprocess.TimeoutExpired('node', 65)):
                with self.assertRaisesRegex(RuntimeError, 'camera error'):
                    publish.publish(state, root / 'public', root / 'capture.mjs')
            data = json.loads((root / 'public' / 'data.json').read_text())
            self.assertIsNone(data['entries'][0]['image'])
            self.assertIn('failed', data['entries'][0]['captureError'])
            self.assertEqual(len(list((root / 'public' / 'entries').glob('*.json'))), 1)

    def test_event_between_previous_snapshot_and_publication_is_not_lost(self):
        state = {
            'updatedAt': '2026-11-01T12:30:00Z',
            'phase': 'homestead', 'objective': 'Gather timber', 'milestones': [],
            'events': [
                {'at': '2026-11-01T12:14:59Z', 'bot': 'Moss', 'type': 'gather', 'message': 'Old event'},
                {'at': '2026-11-01T12:15:03Z', 'bot': 'Roy', 'type': 'gather', 'message': 'Mined iron_ore at (1, 2, 3).'},
                {'at': '2026-11-01T12:15:04Z', 'bot': 'Roy', 'type': 'mission', 'message': 'Long internal instructions are not field notes'},
            ],
        }
        state['bots'] = []
        context = publish.diary_context(state, '2026-11-01T12:15:00+00:00')
        self.assertEqual(context['facts'], ['Roy: Mined 1 iron ore; inventory pickup is tracked separately.'])

    def test_field_notes_keep_real_setbacks_without_internal_traces_or_claiming_pickup(self):
        events = [
            {'bot': 'Moss', 'type': 'gather', 'message': 'Mined oak_log at (1, 2, 3).'},
            {'bot': 'Moss', 'type': 'gather', 'message': 'Mined oak_log at (1, 3, 3).'},
            {'bot': 'Moss', 'type': 'program_result', 'message': 'Stack trace: undefined'},
            {'bot': 'Moss', 'type': 'mission', 'message': 'Build the lodge'},
            {'bot': 'Moss', 'type': 'error', 'message': 'Program: No reachable stone.\nInternal details'},
            {'bot': 'Roy', 'type': 'death', 'message': 'Died'},
        ]
        self.assertEqual(publish.field_notes(events), [
            'Roy: Died 1 time(s); dropped items remain in the world.',
            'Moss: Mined 2 oak log; inventory pickup is tracked separately.',
            'Moss: Encountered a blocker — No reachable stone.',
        ])

    def test_model_failure_preserves_published_history_and_does_not_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'public'
            output.mkdir()
            old = '{"entries": [{"observedAt": "2026-11-01T12:00:00Z", "summary": "Keep me"}]}'
            (output / 'data.json').write_text(old)
            state = root / 'state.json'
            state.write_text(json.dumps({
                'updatedAt': datetime.now(timezone.utc).isoformat(),
                'objective': 'Build a home', 'bots': [], 'events': [],
            }))
            with patch('publish.narrate', side_effect=RuntimeError('Terra failed')):
                with patch('publish.subprocess.run') as capture:
                    with self.assertRaisesRegex(RuntimeError, 'Terra failed'):
                        publish.publish(state, output, root / 'capture.mjs')
                    capture.assert_not_called()
            self.assertEqual((output / 'data.json').read_text(), old)

    def test_success_keeps_archive_and_pairs_terra_paragraph_with_new_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'public'
            output.mkdir()
            old = {'observedAt': '2026-11-01T12:00:00Z', 'summary': 'Keep me'}
            (output / 'data.json').write_text(json.dumps({'entries': [old]}))
            state = root / 'state.json'
            state.write_text(json.dumps({
                'updatedAt': datetime.now(timezone.utc).isoformat(),
                'phase': 'equipment', 'objective': 'Build a home',
                'longTerm': 'Dragon', 'serverVersion': 'Java 26.3',
                'bots': [], 'milestones': [], 'events': [],
            }))
            narrative = {'text': 'My subjective diary.', 'model': 'gpt-6.1-terra', 'answerEntryId': 'answer-42'}

            def capture(command, **kwargs):
                Image.new('RGB', (640, 360), '#add8e6').save(command[-1])

            with patch('publish.narrate', return_value=narrative) as generate:
                with patch('publish.subprocess.run', side_effect=capture):
                    publish.publish(state, output, root / 'capture.mjs')
            data = json.loads((output / 'data.json').read_text())
            self.assertEqual(data['entries'][1], old)
            entry = data['entries'][0]
            self.assertEqual(entry['summary'], narrative['text'])
            self.assertEqual(entry['events'], [])
            self.assertEqual(entry['answerEntryId'], 'answer-42')
            self.assertEqual(entry['author'], 'gpt-6.1-terra')
            self.assertTrue((output / entry['image']).exists())
            self.assertIsNone(entry['captureError'])
            self.assertEqual(generate.call_args.args[0]['since'], old['observedAt'])

    def test_only_server_confirmed_meals_enter_narrative_facts(self):
        state = {
            'updatedAt': '2026-11-01T12:30:00Z', 'objective': 'Home', 'bots': [],
            'events': [
                {'at': '2026-11-01T12:29:00Z', 'bot': 'Roy', 'type': 'eat', 'message': 'Real meal', 'data': {'verified': True}},
                {'at': '2026-11-01T12:29:01Z', 'bot': 'Roy', 'type': 'eat', 'message': 'Unverified meal', 'data': {}},
            ],
        }
        self.assertEqual(publish.diary_context(state, '')['facts'], ['Roy: Real meal'])

    def test_confirmed_crafting_and_lodge_blocks_are_not_lost_or_promoted_to_a_house(self):
        state = {
            'updatedAt': '2026-11-01T12:30:00Z', 'objective': 'Home', 'bots': [],
            'events': [
                {'at': '2026-11-01T12:29:00Z', 'bot': 'Flint', 'type': 'craft', 'message': 'Crafted stone sword', 'data': {'item': 'stone_sword', 'count': 1}},
                {'at': '2026-11-01T12:29:01Z', 'bot': 'Roy', 'type': 'build', 'message': 'Placed air', 'data': {}},
                {'at': '2026-11-01T12:29:02Z', 'bot': 'Roy', 'type': 'build', 'message': 'Placed log', 'data': {'verified': True, 'scope': 'lodge', 'material': 'oak_log'}},
                {'at': '2026-11-01T12:29:03Z', 'bot': 'Roy', 'type': 'build', 'message': 'Placed air', 'data': {'verified': True, 'scope': 'lodge', 'material': 'minecraft:air'}},
            ],
        }
        self.assertEqual(publish.diary_context(state, '')['facts'], [
            'Flint: Crafted 1 stone_sword.',
            'Roy: Placed one verified oak_log lodge block; this does not establish a finished house.',
        ])

    def test_uniform_sky_from_a_completed_renderer_frame_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frame.webp'
            Image.new('RGB', (1440, 900), '#add8e6').save(path)
            publish.validate_frame(path)

    def test_undersized_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frame.webp'
            Image.new('RGB', (100, 100), '#add8e6').save(path)
            with self.assertRaisesRegex(ValueError, 'too small'):
                publish.validate_frame(path)

    def test_corrupt_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frame.png'
            path.write_bytes(b'not an image')
            with self.assertRaises(OSError):
                publish.validate_frame(path)


if __name__ == '__main__':
    unittest.main()

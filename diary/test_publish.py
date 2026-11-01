import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
import subprocess

import publish


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

    def test_failed_capture_publishes_explicit_error_not_previous_image(self):
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
        entry = publish.make_entry(state, '2026-11-01T12:30:05Z', None, None, '2026-11-01T12:15:00+00:00')
        self.assertEqual(entry['events'], ['Roy: Mined 1 iron ore; inventory pickup is tracked separately.'])

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

    def test_corrupt_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frame.png'
            path.write_bytes(b'not an image')
            with self.assertRaises(OSError):
                publish.validate_frame(path)


if __name__ == '__main__':
    unittest.main()

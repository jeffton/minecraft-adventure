#!/usr/bin/env python3
"""Publish observed gameplay and a real bot-camera frame, atomically."""
import argparse
import copy
import fcntl
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

from PIL import Image

WRITER = Path(__file__).resolve().parent.parent / 'player' / 'diary-writer.mjs'


def world_identity(state):
    identity = state['worldId']
    if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', identity):
        raise ValueError('worldId must be a stable filesystem-safe identity, 1–80 characters')
    return identity


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o644)
    os.replace(temporary, path)


def validate_frame(path):
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        if image.width < 640 or image.height < 360:
            raise ValueError('Camera frame is too small')


def public_bot(bot):
    return {
        'name': bot['name'], 'role': 'Autonomous player', 'health': bot['health'],
        'food': bot['food'], 'task': bot['task'], 'status': bot['status'],
    }


def field_notes(events):
    notes = []
    for bot in dict.fromkeys(event['bot'] for event in events):
        observed = [event for event in events if event['bot'] == bot]
        mined = {}
        for event in observed:
            if event['type'] == 'gather' and event['message'].startswith('Mined '):
                block = event['message'].split()[1]
                mined[block] = mined.get(block, 0) + 1
        if mined:
            blocks = ', '.join(f'{count} {name.replace("_", " ")}' for name, count in mined.items())
            notes.append(f'{bot}: Mined {blocks}; inventory pickup is tracked separately.')
        deaths = sum(event['type'] == 'death' for event in observed)
        if deaths:
            notes.append(f'{bot}: Died {deaths} time(s); dropped items remain in the world.')
        # Intentions and internal execution traces are not completed gameplay.
        for event in observed:
            if event['type'] in {'milestone', 'delivery'}:
                notes.append(f"{bot}: {event['message']}")
        errors = [event for event in observed if event['type'] == 'error']
        if errors:
            message = errors[-1]['message'].removeprefix('Program: ')
            notes.append(f'{bot}: Encountered a blocker — {message.splitlines()[0]}')
    return notes


def ledger_events(state_path, state, since):
    world_id = world_identity(state)
    start = datetime.fromisoformat(since.replace('Z', '+00:00')) if since else None
    end = datetime.fromisoformat(state['updatedAt'].replace('Z', '+00:00'))
    selected = []
    with (state_path.parent / f'gameplay-{world_id}.jsonl').open(encoding='utf-8') as ledger:
        for line in ledger:
            event = json.loads(line)
            at = datetime.fromisoformat(event['at'].replace('Z', '+00:00'))
            if (start is None or at > start) and at <= end:
                if event['worldId'] != world_id:
                    raise ValueError('Gameplay ledger event worldId does not match current observations')
                selected.append(event)
    return selected


def diary_context(state, since):
    events = [event for event in state['events'] if not since or (
        datetime.fromisoformat(event['at'].replace('Z', '+00:00'))
        > datetime.fromisoformat(since.replace('Z', '+00:00'))
    )]
    facts = field_notes(events)
    for event in events:
        if event['type'] == 'eat' and event['data'].get('verified') is True:
            facts.append(f"{event['bot']}: {event['message']}")
        if event['type'] == 'action' and event['data'].get('verified') is True:
            facts.append(f"{event['bot']}: {event['message']}")
        if event['type'] == 'craft':
            facts.append(f"{event['bot']}: Crafted {event['data']['count']} {event['data']['item']}.")
        if (event['type'] == 'build' and event['data'].get('verified') is True
                and event['data']['material'].removeprefix('minecraft:') not in {'air', 'cave_air', 'void_air'}):
            facts.append(f"{event['bot']}: Placed one verified {event['data']['material']} block; this does not establish a finished house.")
    return {
        'worldId': world_identity(state), 'observedAt': state['updatedAt'], 'since': since,
        'objective': state['objective'],
        'facts': facts,
        'bots': [{key: bot[key] for key in (
            'name', 'status', 'health', 'food', 'inventory'
        )} for bot in state['bots']],
    }


def narrate(context):
    result = subprocess.run(
        ['node', str(WRITER)], input=json.dumps(context), text=True,
        capture_output=True, check=False, timeout=150,
    )
    if result.returncode != 0:
        raise RuntimeError(f'Diary writer failed: {result.stderr.strip()}')
    return json.loads(result.stdout)


def make_entry(state, now, image, capture_error, narrative):
    return {
        'worldId': world_identity(state), 'at': now, 'observedAt': state['updatedAt'],
        'title': narrative['title'], 'summary': narrative['text'],
        'events': [],
        'author': narrative['model'], 'generationId': narrative['generationId'],
        'image': image, 'captureError': capture_error,
    }


def publish(state_path, output, capture_script):
    now = datetime.now(timezone.utc)
    state = json.loads(state_path.read_text())
    observed = datetime.fromisoformat(state['updatedAt'].replace('Z', '+00:00'))
    if (now - observed).total_seconds() > 120:
        raise RuntimeError('Gameplay observations are stale; refusing to label them current')
    world_id = world_identity(state)
    stamp = world_id + '-' + now.strftime('%Y%m%dT%H%M%SZ')
    images = output / 'images'
    images.mkdir(parents=True, exist_ok=True)
    data_path = output / 'data.json'
    previous = json.loads(data_path.read_text()) if data_path.exists() else {'entries': []}
    same_world = previous.get('worldId') == world_id
    old_id = world_identity(previous) if previous['entries'] and not same_world else None
    entries = previous['entries'] if same_world else []
    since = entries[0]['observedAt'] if entries else ''
    if state.get('gameplayLedger') is True:
        state['events'] = ledger_events(state_path, state, since)
    context = {**diary_context(state, since), 'mode': 'entry',
               'usedTitles': [entry['title'] for entry in entries if 'title' in entry]}
    narrative = narrate(context)
    if narrative['title'].strip().casefold() in {title.strip().casefold() for title in context['usedTitles']}:
        raise ValueError('Diary title repeats an existing field note')
    if narrative['worldId'] != world_id:
        raise ValueError('Diary narrative worldId does not match current observations')
    image_path = images / f'{stamp}.webp'
    temporary = images / f'.{stamp}.webp'
    capture_error = None
    try:
        subprocess.run(['node', str(capture_script), str(temporary)], check=True, timeout=65)
        validate_frame(temporary)
        os.replace(temporary, image_path)
        image = f'images/{stamp}.webp'
    except (subprocess.SubprocessError, ValueError, OSError) as error:
        print(f'Camera capture failed: {error}', file=sys.stderr)
        capture_error = 'No current camera image: capture failed.'
        image = None
    now_text = now.isoformat()
    entry = make_entry(state, now_text, image, capture_error, narrative)
    archives = list(previous.get('archives', []))
    if old_id is not None:
        archive_directory = output / 'archives' / old_id
        archive_directory.mkdir(parents=True, exist_ok=True)
        atomic_json(archive_directory / 'data.json', previous)
        archives.append({'worldId': old_id, 'path': f'archives/{old_id}/data.json'})
    data = {
        'worldId': world_id, 'archives': archives,
        'publishedAt': now_text, 'observedAt': state['updatedAt'],
        'objective': state['objective'], 'longTerm': state['longTerm'],
        'serverVersion': state['serverVersion'],
        'bots': [public_bot(bot) for bot in state['bots']],
        'milestones': state['milestones'],
        'entries': [entry, *entries],
    }
    archive = output / 'entries'
    archive.mkdir(exist_ok=True)
    atomic_json(archive / f'{stamp}.json', entry)
    atomic_json(data_path, data)
    if capture_error is not None:
        raise RuntimeError('Diary published with explicit camera error')
    print(f'Published {stamp}: {len(data["bots"])} bots, {image}')


def retitle(output):
    data_path = output / 'data.json'
    original = data_path.read_text()
    data = json.loads(original)
    entries = data['entries']
    generated = narrate({'mode': 'titles', 'entries': [
        {'at': entry['at'], 'summary': entry['summary']} for entry in entries
    ], 'usedTitles': []})
    if len(generated) != len(entries):
        raise ValueError('Incomplete title migration')
    titles = {item['at']: item['title'] for item in generated}
    if set(titles) != {entry['at'] for entry in entries} or len({title.casefold() for title in titles.values()}) != len(entries):
        raise ValueError('Title migration identities or uniqueness failed')
    updates = []
    for path in sorted((output / 'entries').glob('*.json')):
        entry = json.loads(path.read_text())
        if entry.get('worldId') == data['worldId'] and entry['at'] in titles:
            entry['title'] = titles[entry['at']]
            updates.append((path, entry))
    if len(updates) != len(entries):
        raise ValueError('Entry files do not match the current diary')
    if data_path.read_text() != original:
        raise RuntimeError('Diary changed during title generation')
    before = copy.deepcopy(data)
    for entry in entries:
        entry['title'] = titles[entry['at']]
    for old, new in zip(before['entries'], entries):
        assert {key: value for key, value in old.items() if key != 'title'} == {key: value for key, value in new.items() if key != 'title'}
    for path, entry in updates:
        atomic_json(path, entry)
    atomic_json(data_path, data)
    print(f'Retitled {len(entries)} field notes; paragraphs, dates and images preserved')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=Path('/var/lib/minecraft-adventure/observations/state.json'))
    parser.add_argument('--output', type=Path, default=Path('/var/www/roybot.se/minecraft'))
    parser.add_argument('--capture', type=Path, default=Path(__file__).with_name('capture.mjs'))
    parser.add_argument('--retitle', action='store_true', help='Generate titles for existing entries only')
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    with (arguments.output / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if arguments.retitle:
            retitle(arguments.output)
        else:
            publish(arguments.state, arguments.output, arguments.capture)

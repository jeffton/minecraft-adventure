#!/usr/bin/env python3
"""Network checks for proxy authentication and backend isolation (non-root)."""

import json
import os
import socket
import struct
import uuid


def varint(value):
    result = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        result.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(result)


def read_varint(stream):
    result = 0
    for shift in range(0, 35, 7):
        byte = stream.read(1)
        if not byte:
            raise EOFError('Connection closed')
        result |= (byte[0] & 0x7f) << shift
        if not byte[0] & 0x80:
            return result
    raise ValueError('Invalid VarInt')


def string(value):
    data = value.encode()
    return varint(len(data)) + data


def send(stream, packet_id, payload=b''):
    packet = varint(packet_id) + payload
    stream.write(varint(len(packet)) + packet)
    stream.flush()


def receive(stream, compressed=False):
    import io
    import zlib
    size = read_varint(stream)
    data = stream.read(size)
    if len(data) != size:
        raise EOFError('Incomplete packet')
    packet = io.BytesIO(data)
    if compressed:
        uncompressed_size = read_varint(packet)
        payload = packet.read()
        data = zlib.decompress(payload) if uncompressed_size else payload
        packet = io.BytesIO(data)
    return read_varint(packet), packet


def connect(port, state):
    connection = socket.create_connection(('127.0.0.1', port), timeout=15)
    stream = connection.makefile('rwb')
    # 26.3 protocol 777 is native to both Paper and Velocity.
    send(stream, 0, varint(777) + string('localhost') + struct.pack('>H', port) + varint(state))
    return connection, stream


def ping(port):
    connection, stream = connect(port, 1)
    try:
        send(stream, 0)
        identifier, packet = receive(stream)
        assert identifier == 0
        length = read_varint(packet)
        result = json.loads(packet.read(length))
        assert result['version']['protocol'] == 777, result
        return result
    finally:
        stream.close()
        connection.close()


def login(port, name):
    connection, stream = connect(port, 2)
    send(stream, 0, string(name) + uuid.uuid4().bytes)
    return connection, stream


def main():
    assert os.geteuid() != 0, 'Run this check as a dedicated non-root account.'
    for port in [25566, 25567]:
        result = ping(port)
        print(f'{port}: native status OK ({result["version"]["name"]})')
    connection, stream = login(25566, 'Roy')
    try:
        identifier, query = receive(stream)
        assert identifier == 4, f'Expected modern forwarding query, got {identifier}'
        transaction = read_varint(query)
        channel_length = read_varint(query)
        channel = query.read(channel_length).decode()
        assert channel == 'velocity:player_info', channel
        send(stream, 2, varint(transaction) + b'\x00')
        identifier, packet = receive(stream)
        assert identifier == 0, f'Expected direct-backend disconnect, got {identifier}'
        assert b'Velocity' in packet.read()
        print('Direct backend login rejected without Velocity forwarding.')
    finally:
        stream.close()
        connection.close()
    if os.environ.get('CHECK_PUBLIC') == '1':
        ping(25565)
        connection, stream = login(25565, 'PublicProbe')
        try:
            identifier, packet = receive(stream)
            assert identifier == 1, f'Public proxy must request authentication, got {identifier}'
            length = read_varint(packet)
            packet.read(length)
            key_length = read_varint(packet)
            packet.read(key_length)
            token_length = read_varint(packet)
            packet.read(token_length)
            assert packet.read(1) == b'\x01', 'Authentication must be required.'
            print('Public proxy requires encrypted Microsoft session authentication.')
        finally:
            stream.close()
            connection.close()


if __name__ == '__main__':
    main()

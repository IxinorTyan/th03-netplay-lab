"""Exercise real HTTP room rules and same-port authenticated WebSocket relay."""
import asyncio
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lan_server import Handler, ROOT, PROTOCOL
import websockets

def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    def api(path, data, expected=200):
        request = Request(base + '/api/' + path, data=json.dumps({'protocol': PROTOCOL, **data}).encode(),
                          headers={'Content-Type': 'application/json'})
        try: response = urlopen(request, timeout=5)
        except HTTPError as error: response = error
        with response:
            assert response.status == expected, (path, response.status, expected)
            return json.load(response)
    try:
        host = api('create', {'mode': 'relay'})
        assert host['state']['settings']['rollback'] is False
        assert host['state']['settings']['focusEnabled'] is True
        guest = api('join', {'room': host['room'], 'mode': 'rtc'})
        assert guest['state']['mode'] == 'relay'
        h = {'room': host['room'], 'token': host['token']}
        g = {'room': guest['room'], 'token': guest['token']}
        api('start', h, 409)
        api('settings', {**g, 'settings': {'language': 'cn', 'difficulty': 3, 'clock': 8, 'rollback': True, 'focusEnabled': False}}, 403)
        api('ready', h); api('ready', g)
        settings = {'language': 'cn', 'difficulty': 3, 'clock': 8, 'rollback': True, 'focusEnabled': False}
        api('settings', {**h, 'settings': {**settings, 'focusEnabled': 'false'}}, 400)
        changed = api('settings', {**h, 'settings': settings})
        assert changed['settings'] == settings and not any(changed['ready'].values())
        api('ready', h); api('ready', g)
        started = api('start', h); assert started['started']
        api('settings', {**h, 'settings': settings}, 403)
        api('progress', {**h, 'message': 'ready', 'loaded': True})
        progress = api('progress', {**h, 'message': 'waiting', 'loaded': False})
        assert progress['startup']['host']['loaded']
        async def relay():
            def url(identity, role):
                return base.replace('http:', 'ws:') + '/relay?' + urlencode({**identity, 'role': role, 'protocol': PROTOCOL})
            try:
                async with websockets.connect(url({**h, 'token': 'invalid'}, 'host'), origin=base):
                    raise AssertionError('Invalid relay identity accepted')
            except websockets.exceptions.InvalidStatus: pass
            async with websockets.connect(url(h, 'host'), origin=base) as a, websockets.connect(url(g, 'guest'), origin=base) as b:
                assert json.loads(await a.recv())['type'] == 'ready'
                assert json.loads(await b.recv())['type'] == 'ready'
                packet = {'type': 'input', 'seq': 7, 'actions': ['up', 'focus'],
                          'touch': 2**42 + 2**41 + 2**40 + 160 * 4096 + 16304 * 2**26}
                await a.send(json.dumps(packet)); assert json.loads(await asyncio.wait_for(b.recv(), 3)) == packet
                packet = {'type': 'input', 'seq': 8, 'actions': []}
                await b.send(json.dumps(packet)); assert json.loads(await asyncio.wait_for(a.recv(), 3)) == packet
                for packet in [
                    {'sync': 'th03-rollback/1', 'type': 'rollback', 'frame': 120},
                    {'sync': 'th03-rollback/1', 'type': 'sync-ready', 'identity': {'disk': 'same'}},
                    {'sync': 'th03-rollback/1', 'type': 'frame', 'frame': 4,
                     'input': {'actions': ['shot'], 'touch': 0, 'focusEnabled': True, 'points': False, 'commands': ['pause']}},
                    {'sync': 'th03-rollback/1', 'type': 'check', 'frame': 120, 'hash': 'abc123'},
                ]:
                    await a.send(json.dumps(packet)); assert json.loads(await asyncio.wait_for(b.recv(), 3)) == packet
                await b.close(); assert json.loads(await asyncio.wait_for(a.recv(), 3))['type'] == 'peer-left'
        asyncio.run(relay())
        api('leave', g); state = api('ready', h)
        assert not state['present']['guest'] and not state['started']
        api('leave', h)
        rtc = api('create', {'mode': 'rtc'}); peer = api('join', {'room': rtc['room']})
        assert rtc['state']['settings']['rollback'] is False
        rh = {'room': rtc['room'], 'token': rtc['token']}
        rg = {'room': peer['room'], 'token': peer['token']}
        api('ready', rh); api('ready', rg); api('start', rh)
        api('signal', {**rh, 'to': 'guest', 'message': {'type': 'offer', 'description': {'type': 'offer', 'sdp': 'test'}}})
        with urlopen(base + '/api/signals?' + urlencode({'protocol': PROTOCOL, **rg})) as response:
            assert json.load(response)['messages'][0]['message']['type'] == 'offer'
        print('PASS: room readiness, host settings, invalidation, progress barrier, same-port Relay auth/input/release/disconnect, RTC signals')
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)

if __name__ == '__main__': main()

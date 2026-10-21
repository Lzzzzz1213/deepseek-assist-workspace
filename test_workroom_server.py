import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from workroom_server import EventStore, WorkroomServer, redact


class WorkroomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workroom-test-')
        self.root = Path(self.temp.name)
        self.events = self.root / 'events'
        self.events.mkdir()
        self.view_state_dir = self.root / 'client-state'
        (self.root/'web').mkdir()
        (self.root/'web/index.html').write_text('<!doctype html><title>fixture</title>', encoding='utf-8')
        self.room = 'a'*32
        self.run = '1'*32

    def tearDown(self):
        self.temp.cleanup()

    def event(self, kind, text='', payload=None, room=None, run=None, actor='codex'):
        return {'v': 1, 'eventId': str(uuid.uuid4()), 'runId': run or self.run, 'roomId': room or self.room, 'time': '2026-10-16T00:00:00Z', 'type': kind, 'actor': actor, 'text': text, 'payload': payload or {}}

    def write(self, items, run=None):
        (self.events/((run or self.run)+'.jsonl')).write_text(''.join(json.dumps(x)+'\n' for x in items), encoding='utf-8')

    def test_events_redaction_cache_and_delete_scope(self):
        self.write([self.event('task.created', 'task token=secret123', {'title':'demo', 'roomTitle':'群', 'parentPid': os.getpid()}), self.event('message', '<script>alert(1)</script> sk-abcdefghijklmnop', {'phase':'public', 'reasoning':'DO NOT LEAK'}), self.event('message', 'DO NOT LEAK', {'phase':'reasoning'}), self.event('reasoning', 'DO NOT LEAK'), self.event('tool', 'DO NOT LEAK', {'operation':'read_file','path':'main.py','result':'ok', 'output':'DO NOT LEAK'}), self.event('task.completed', payload={'status':'success','usage':{'input_tokens':9,'reasoning':'DO NOT LEAK'}})])
        file = self.events/(self.run+'.jsonl')
        with file.open('a', encoding='utf-8') as f:
            f.write('broken\n{"partial":')
        store = EventStore(self.events, view_state_dir=self.view_state_dir)
        detail = store.detail(self.room)
        raw = json.dumps(detail)
        self.assertNotIn('DO NOT LEAK', raw)
        self.assertNotIn('abcdefghijklmnop', raw)
        self.assertNotIn('secret123', raw)
        self.assertIn('<script>', raw)  # API保持纯文本，前端必须textContent而非innerHTML。
        self.assertEqual(detail['runs'][0]['status'], 'success')
        self.assertEqual(len(detail['messages']), 2)
        self.assertEqual({m['type'] for m in detail['messages']}, {'task.created', 'message'})
        self.assertNotIn('read_file', raw)
        self.assertEqual(store.state()['stats']['messages'], 2)
        self.assertNotIn('passed', raw)
        revision = store.state()['revision']
        self.assertEqual(revision, store.state()['revision'])
        other_run, other_room = '2'*32, 'b'*32
        self.write([self.event('task.created', run=other_run, room=other_room), self.event('task.completed', run=other_run, room=other_room, payload={'status':'success'})], run=other_run)
        self.assertNotEqual(revision, store.state()['revision'])
        original = (self.events/(self.run+'.jsonl')).read_bytes()
        status, result = store.delete(self.room, store.detail(self.room)['room']['clearRevision'])
        self.assertEqual((self.events/(self.run+'.jsonl')).read_bytes(), original)
        self.assertEqual(status, 200)
        self.assertEqual(result['deleted'], 1)
        self.assertTrue((self.events/(other_run+'.jsonl')).exists())

    def test_running_and_dead_parent(self):
        self.write([self.event('task.created', payload={'parentPid':os.getpid()})])
        store = EventStore(self.events, view_state_dir=self.view_state_dir)
        self.assertEqual(store.delete(self.room)[0], 409)
        with patch('workroom_server.parent_alive', return_value=False):
            self.assertEqual(store.detail(self.room)['runs'][0]['status'], 'interrupted')
        self.write([self.event('task.created', payload={'parentPid': os.getpid(), 'parentStartFileTime':1})])
        if os.name == 'nt':
            self.assertEqual(store.detail(self.room)['runs'][0]['status'], 'interrupted')

    def test_link_and_mixed_room_rejection(self):
        self.write([self.event('task.created'), self.event('task.completed', payload={'status':'success'})])
        os.link(self.events/(self.run+'.jsonl'), self.root/'outside.jsonl')
        self.assertEqual(EventStore(self.events, view_state_dir=self.view_state_dir).state()['stats']['rooms'], 0)
        mixed = '3'*32
        self.write([self.event('task.created', run=mixed), self.event('task.created', run=mixed, room='b'*32)], mixed)
        self.assertEqual(EventStore(self.events, view_state_dir=self.view_state_dir).state()['stats']['rooms'], 0)

    def test_http_security_and_export(self):
        self.write([self.event('task.created'), self.event('task.completed', payload={'status':'success'})])
        server = WorkroomServer(0, self.events, self.root, view_state_dir=self.view_state_dir)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        def request(path, method='GET', headers=None, body=None):
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            result = (response.status, dict(response.getheaders()), response.read())
            conn.close()
            return result
        try:
            self.assertEqual(request('/health')[0], 200)
            self.assertEqual(request('/api/state')[0], 403)
            response = request('/')
            self.assertEqual(response[0], 200)
            self.assertIn('HttpOnly', response[1]['Set-Cookie'])
            self.assertIn("frame-ancestors 'none'", response[1]['Content-Security-Policy'])
            auth = {'Cookie': response[1]['Set-Cookie'].split(';')[0], 'X-Workroom-Client':'1'}
            self.assertEqual(request('/api/state', headers=auth)[0], 200)
            for extra in [{'Host':'evil.example'}, {'Origin':'https://evil.example'}, {'Sec-Fetch-Site':'cross-site'}]:
                self.assertEqual(request('/api/state', headers={**auth, **extra})[0], 403)
            self.assertEqual(request('/api/state', headers={'Cookie':auth['Cookie']})[0], 403)
            for path in ['/../workroom_server.py', '/%2e%2e/workroom_server.py', '/workroom_server.py', '/api/rooms/../../../']:
                self.assertEqual(request(path, headers=auth)[0], 404)
            self.assertEqual(request('/api/state', 'POST', auth, '{}')[0], 405)
            self.assertEqual(request('/api/state', 'OPTIONS', auth)[0], 405)
            export = request('/api/rooms/'+self.room+'/export', headers=auth)
            self.assertEqual(export[0], 200)
            self.assertIn('attachment', export[1]['Content-Disposition'])
            self.assertEqual(request('/api/rooms/'+self.room, 'DELETE', auth)[0], 415)
            self.assertEqual(request('/api/rooms/'+self.room, 'DELETE', {**auth, 'Content-Type':'application/json'}, '{}')[0], 400)
            detail = json.loads(request('/api/rooms/'+self.room, headers=auth)[2])
            original = (self.events/(self.run+'.jsonl')).read_bytes()
            body = json.dumps({'revision':detail['room']['clearRevision']})
            status = request('/api/rooms/'+self.room, 'DELETE', {**auth, 'Content-Type':'application/json'}, body)[0]
            self.assertEqual(status, 200)
            self.assertEqual((self.events/(self.run+'.jsonl')).read_bytes(), original)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_empty_cached_parse_is_retried(self):
        self.write([self.event('task.created', 'visible task'), self.event('task.completed', payload={'status':'success'})])
        store = EventStore(self.events, view_state_dir=self.view_state_dir)
        self.assertEqual(len(store.state()['rooms']), 1)
        signature = store.cache[self.run][0]
        store.cache[self.run] = (signature, [])
        state = store.state()
        self.assertEqual(len(state['rooms']), 1)
        self.assertEqual(state['privacy']['readStatus']['state'], 'ok')

    def test_read_error_is_reported_without_message_content(self):
        private_text = 'private message must stay out of diagnostic errors'
        self.write([self.event('task.created', private_text)])
        original = Path.read_bytes
        target = self.events/(self.run+'.jsonl')
        def guarded(path):
            if path == target:
                raise PermissionError(private_text)
            return original(path)
        with patch.object(Path, 'read_bytes', guarded):
            state = EventStore(self.events, view_state_dir=self.view_state_dir).state()
        self.assertEqual(state['privacy']['readStatus']['state'], 'error')
        self.assertTrue(state['privacy']['readStatus']['errors'])
        self.assertNotIn(private_text, json.dumps(state))

    def test_partial_record_recovers_after_valid_append(self):
        target = self.events/(self.run+'.jsonl')
        target.write_text('invalid\n{"unfinished":', encoding='utf-8')
        store = EventStore(self.events, view_state_dir=self.view_state_dir)
        self.assertEqual(store.state()['privacy']['readStatus']['state'], 'error')
        with target.open('a', encoding='utf-8') as stream:
            stream.write('\n'+json.dumps(self.event('task.created', 'restored'))+'\n')
        state = store.state()
        self.assertEqual(state['privacy']['readStatus']['state'], 'ok')
        self.assertEqual(len(state['rooms']), 1)

    def test_missing_record_directory_is_not_read_failure(self):
        state = EventStore(self.root/'not-created', view_state_dir=self.view_state_dir).state()
        self.assertEqual(state['privacy']['readStatus']['state'], 'missing')
        self.assertEqual(state['stats']['rooms'], 0)

    def test_redaction(self):
        output = redact('Bearer abc.def password="secret" token=xyz -----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----')
        for secret in ['abc.def', 'secret"', '=xyz', '\nprivate\n']:
            self.assertNotIn(secret, output)


if __name__ == '__main__':
    unittest.main()
